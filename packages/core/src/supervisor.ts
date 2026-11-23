// The service supervisor (container plan P1-T2/T2a; on the host since A6): the decider and the embedding service, each behind a small HTTP front on a random loopback port. The plugin talks to the front
// (@omacode/core/services); the front checks the token, starts the service when it is not running, forwards the request
// when it is, and stops it again after an idle time, so a laptop does not keep a model in memory nobody asks.
//
// Each service is in one of three modes, read from <run>/control.json and changed by the TUI (P3-T6):
//   on   — started now and kept running; restarted when it dies;
//   auto — started now, stopped after `idleMinutes` without a request, started again by the next request (default);
//   off  — not running; a request answers 503 without the "starting" header, so the plugin falls back at once
//          (rules for decisions, keywords for memory search).
// While a service starts, a request answers 503 with `x-omacode-starting: 1` and Retry-After, which the decision client
// waits out and the embedding client treats as "down for a minute". <run>/status.json says what each service is doing.
//
// No package is used: node:http, node:child_process and fetch are enough, and the image carries Node anyway.

import { spawn, type ChildProcess } from "node:child_process"
import { createHash, timingSafeEqual } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createServer as netServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Mode = "on" | "auto" | "off"
export type State = "stopped" | "preparing" | "starting" | "running" | "failed"

export interface ServiceSpec {
  readonly name: string
  // The command for a backend on this loopback port, on the device picked in the control file (or the spec's default).
  command(port: number, device?: string): { readonly cmd: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  // Work before the first start, such as fetching model weights; its progress goes into the status line.
  prepare?(progress: (text: string) => void): Promise<void>
  // Where the backend can run, such as "cpu" and the GPUs llama.cpp lists; asked once at start. None: not switchable.
  devices?(): Promise<readonly Device[]>
  readonly defaultDevice?: string
  readonly health?: string // the backend's health path, "/health" by default
  readonly startTimeoutMs?: number
}

export interface Device {
  readonly id: string
  readonly name: string
  // Why there is no other choice, or what to know about this one; shown in the TUI.
  readonly note?: string
}

export interface SupervisorOptions {
  readonly runDir: string
  readonly token?: string
  readonly services: readonly ServiceSpec[]
  readonly defaults?: Readonly<Record<string, Mode>>
  // Fixed ports for the fronts. A host supervisor takes the services' usual ports (8781, 8093), so a client that read
  // a URL once still reaches it after the supervisor restarts; the container's take random ones (K6).
  readonly ports?: Readonly<Record<string, number>>
  // More facts for services.json, for the clients: the embedding model the service runs, for one.
  readonly facts?: Readonly<Record<string, string>>
  readonly idleMs?: number
  readonly pollMs?: number
  // Where the control file is; <run>/control.json by default. The host's keeps it on disk, so a pick survives a
  // reboot (the run directory is a tmpfs). status.json names it, so the clients write to the right one.
  readonly controlPath?: string
}

interface Status {
  mode: Mode
  state: State
  url: string
  pid?: number
  lastUsed?: string
  detail?: string
  device?: string
  devices?: readonly Device[]
}

interface Running {
  readonly spec: ServiceSpec
  readonly front: Server
  readonly url: string
  mode: Mode
  state: State
  child?: ChildProcess
  port?: number
  starting?: Promise<void>
  stopping?: boolean
  prepared: boolean
  active: number
  lastUsed: number
  detail?: string
  restarts: number[]
  device?: string
  devices?: readonly Device[]
}

export const STARTING_HEADER = "x-omacode-starting"
const MODES: readonly Mode[] = ["on", "auto", "off"]

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = netServer()
    s.once("error", fail)
    s.listen(0, "127.0.0.1", () => {
      const address = s.address()
      const port = typeof address === "object" && address ? address.port : 0
      s.close(() => (port ? done(port) : fail(new Error("no free port"))))
    })
  })
}

const sameToken = (header: string | undefined, token: string): boolean => {
  const want = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(header ?? "")
  return got.length === want.length && timingSafeEqual(got, want)
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

// The control file: a mode per service, the idle time, and a device per service ({"devices": {"embedding": "Vulkan1"}}).
// Anything unreadable keeps the defaults.
export function readControl(path: string, names: readonly string[], defaults: Readonly<Record<string, Mode>>): { modes: Record<string, Mode>; idleMs?: number; devices: Record<string, string> } {
  const modes: Record<string, Mode> = {}
  for (const n of names) modes[n] = defaults[n] ?? "auto"
  let idleMs: number | undefined
  const devices: Record<string, string> = {}
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    for (const n of names) if (MODES.includes(raw[n] as Mode)) modes[n] = raw[n] as Mode
    const minutes = Number(raw.idleMinutes)
    if (Number.isFinite(minutes) && minutes > 0) idleMs = minutes * 60_000
    const picked = raw.devices && typeof raw.devices === "object" ? (raw.devices as Record<string, unknown>) : {}
    for (const n of names) if (typeof picked[n] === "string" && picked[n]) devices[n] = picked[n] as string
  } catch {
    // no control file yet, or a half-written one: the defaults hold until the next poll
  }
  return { modes, ...(idleMs ? { idleMs } : {}), devices }
}

export class Supervisor {
  readonly #o: SupervisorOptions
  readonly #services = new Map<string, Running>()
  #idleMs: number
  #timer?: NodeJS.Timeout
  #controlStamp = ""
  #closed = false

  private constructor(o: SupervisorOptions) {
    this.#o = o
    this.#idleMs = o.idleMs ?? 10 * 60_000
  }

  static async start(o: SupervisorOptions): Promise<Supervisor> {
    mkdirSync(o.runDir, { recursive: true, mode: 0o700 })
    const sup = new Supervisor(o)
    for (const spec of o.services) {
      const front = createServer((req, res) => void sup.#handle(spec.name, req, res))
      await new Promise<void>((done, fail) => {
        front.once("error", fail)
        front.listen(o.ports?.[spec.name] ?? 0, "127.0.0.1", () => done())
      })
      const address = front.address()
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
      sup.#services.set(spec.name, { spec, front, url, mode: o.defaults?.[spec.name] ?? "auto", state: "stopped", prepared: !spec.prepare, active: 0, lastUsed: Date.now(), restarts: [], ...(spec.defaultDevice ? { device: spec.defaultDevice } : {}) })
    }
    // Asked before the first start, so a device picked in the control file can be checked against the list.
    await Promise.all([...sup.#services.values()].map(async (s) => {
      if (!s.spec.devices) return
      try {
        s.devices = await s.spec.devices()
      } catch {
        s.devices = undefined
      }
    }))
    writeJson(join(o.runDir, "services.json"), { ...Object.fromEntries([...sup.#services].map(([n, s]) => [n, s.url])), ...(o.facts ?? {}) })
    sup.#applyControl(true)
    sup.#timer = setInterval(() => sup.#tick(), o.pollMs ?? 1000)
    sup.#writeStatus()
    return sup
  }

  get urls(): Record<string, string> {
    return Object.fromEntries([...this.#services].map(([n, s]) => [n, s.url]))
  }

  status(): Record<string, Status> {
    const out: Record<string, Status> = {}
    for (const [n, s] of this.#services) {
      out[n] = {
        mode: s.mode,
        state: s.state,
        url: s.url,
        ...(s.child?.pid ? { pid: s.child.pid } : {}),
        lastUsed: new Date(s.lastUsed).toISOString(),
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.device ? { device: s.device } : {}),
        ...(s.devices ? { devices: s.devices } : {}),
      }
    }
    return out
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    await Promise.all([...this.#services.values()].map(async (s) => {
      await this.#stop(s)
      await new Promise<void>((done) => s.front.close(() => done()))
    }))
  }

  #writeStatus(): void {
    if (this.#closed) return
    try {
      writeJson(join(this.#o.runDir, "status.json"), { updated: new Date().toISOString(), idleMinutes: this.#idleMs / 60_000, control: this.#controlPath, services: this.status() })
    } catch {
      // the run directory went away under a stopping container
    }
  }

  #set(s: Running, state: State, detail?: string): void {
    s.state = state
    s.detail = detail
    this.#writeStatus()
  }

  get #controlPath(): string {
    return this.#o.controlPath ?? join(this.#o.runDir, "control.json")
  }

  #applyControl(first = false): void {
    const path = this.#controlPath
    let stamp = ""
    try {
      const st = statSync(path)
      stamp = `${st.mtimeMs}:${st.size}`
    } catch {
      stamp = "none"
    }
    if (!first && stamp === this.#controlStamp) return
    this.#controlStamp = stamp
    const control = readControl(path, [...this.#services.keys()], this.#o.defaults ?? {})
    if (control.idleMs) this.#idleMs = control.idleMs
    for (const [n, s] of this.#services) {
      const mode = control.modes[n]!
      const changed = mode !== s.mode
      s.mode = mode
      // A device the backend does not list is ignored, so a typo cannot keep a service from starting.
      const asked = control.devices[n] ?? s.spec.defaultDevice
      const device = asked && (!s.devices || s.devices.some((d) => d.id === asked)) ? asked : s.spec.defaultDevice
      const moved = device !== s.device
      s.device = device
      if (mode === "off") void this.#stop(s)
      else if (moved && !first && (s.child || s.starting)) {
        // Running on the old device: stop it and start it again on the new one.
        s.lastUsed = Date.now()
        void this.#restart(s)
      } else if (first || changed) {
        // "auto" starts at once as well, so the first decision of a session does not wait for a model to load.
        s.lastUsed = Date.now()
        void this.#ensure(s).catch(() => undefined)
      }
    }
    this.#writeStatus()
  }

  #tick(): void {
    this.#applyControl()
    const now = Date.now()
    for (const s of this.#services.values()) {
      if (s.mode === "auto" && s.state === "running" && s.active === 0 && now - s.lastUsed > this.#idleMs) {
        void this.#stop(s, `stopped after ${Math.round(this.#idleMs / 60_000)} min without a request`)
      }
    }
  }

  async #handle(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const s = this.#services.get(name)!
    const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers })
      res.end(JSON.stringify(body))
    }
    const open = req.method === "GET" && req.url === "/health"
    if (!open && this.#o.token && !sameToken(req.headers.authorization, this.#o.token)) return reply(401, { error: "missing or wrong token" })
    if (open) return reply(200, { status: s.state, mode: s.mode, ...(s.detail ? { detail: s.detail } : {}) })
    if (s.mode === "off") return reply(503, { error: `${name} is switched off` })
    s.lastUsed = Date.now()
    if (s.state !== "running" || !s.port) {
      void this.#ensure(s).catch(() => undefined)
      if (s.state === "failed") return reply(503, { error: `${name} failed: ${s.detail ?? "unknown"}` })
      return reply(503, { error: `${name} is starting`, state: s.state }, { [STARTING_HEADER]: "1", "retry-after": "2" })
    }
    s.active++
    const done = () => {
      s.active = Math.max(0, s.active - 1)
      s.lastUsed = Date.now()
    }
    const upstream = httpRequest(
      { host: "127.0.0.1", port: s.port, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
        answer.on("end", done)
        answer.on("error", done)
      },
    )
    upstream.on("error", (err) => {
      done()
      if (!res.headersSent) reply(502, { error: `${name}: ${err.message}` })
      else res.destroy()
    })
    req.pipe(upstream)
  }

  // Starts the backend unless it runs or is starting; resolves when it answers its health check.
  #ensure(s: Running): Promise<void> {
    if (s.state === "running" || this.#closed) return Promise.resolve()
    if (s.starting) return s.starting
    const run = async () => {
      if (!s.prepared && s.spec.prepare) {
        this.#set(s, "preparing", "preparing")
        await s.spec.prepare((text) => this.#set(s, "preparing", text))
        s.prepared = true
      }
      const port = await freePort()
      const { cmd, args, env } = s.spec.command(port, s.device)
      this.#set(s, "starting")
      const log = createWriteStream(join(this.#o.runDir, `${s.spec.name}.log`), { flags: "a", mode: 0o600 })
      const child = spawn(cmd, [...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
      child.stdout?.pipe(log, { end: false })
      child.stderr?.pipe(log, { end: false })
      s.child = child
      s.port = port
      child.once("exit", (code, signal) => {
        log.end()
        if (s.child !== child) return
        s.child = undefined
        s.port = undefined
        if (s.stopping || this.#closed) return
        this.#set(s, "failed", `exited (${signal ?? code}); see ${s.spec.name}.log`)
        if (s.mode === "on") {
          const now = Date.now()
          s.restarts = [...s.restarts.filter((t) => now - t < 5 * 60_000), now]
          if (s.restarts.length <= 3) setTimeout(() => void this.#ensure(s).catch(() => undefined), 2000)
        }
      })
      const deadline = Date.now() + (s.spec.startTimeoutMs ?? 15 * 60_000)
      while (Date.now() < deadline) {
        if (s.child !== child) throw new Error(s.detail ?? "exited while starting")
        try {
          const r = await fetch(`http://127.0.0.1:${port}${s.spec.health ?? "/health"}`, { signal: AbortSignal.timeout(2000) })
          if (r.ok) {
            s.lastUsed = Date.now()
            this.#set(s, "running")
            return
          }
        } catch {
          // not listening yet
        }
        await wait(500)
      }
      child.kill("SIGKILL")
      throw new Error("did not answer its health check in time")
    }
    s.starting = run()
      .catch((err: unknown) => {
        if (s.state !== "failed") this.#set(s, "failed", err instanceof Error ? err.message : String(err))
        throw err
      })
      .finally(() => {
        s.starting = undefined
      })
    return s.starting
  }

  async #restart(s: Running): Promise<void> {
    await s.starting?.catch(() => undefined)
    await this.#stop(s, `moving to ${s.device}`)
    if (s.mode !== "off") await this.#ensure(s).catch(() => undefined)
  }

  async #stop(s: Running, detail?: string): Promise<void> {
    const child = s.child
    if (!child) {
      if (s.state !== "stopped" && !s.starting) this.#set(s, "stopped", detail)
      return
    }
    s.stopping = true
    const exited = new Promise<void>((done) => child.once("exit", () => done()))
    child.kill("SIGTERM")
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000)
    await exited
    clearTimeout(killer)
    s.stopping = false
    s.child = undefined
    s.port = undefined
    this.#set(s, "stopped", detail)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Model files the services need.

// Downloads a file once, checked against the SHA-256 the server names for it (Hugging Face sends it as x-linked-etag
// for files in large-file storage). A file that does not match is deleted, not used.
export async function fetchOnce(url: string, file: string, progress: (text: string) => void): Promise<void> {
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  const head = await fetch(url, { method: "HEAD", redirect: "manual" })
  const expected = head.headers.get("x-linked-etag")?.replace(/"/g, "") ?? undefined
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`)
  const total = Number(res.headers.get("content-length")) || 0
  const part = `${file}.part`
  const out = createWriteStream(part)
  const hash = createHash("sha256")
  let got = 0
  let shown = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    got += chunk.length
    if (!out.write(chunk)) await new Promise<void>((done) => out.once("drain", () => done()))
    if (got - shown > 16 * 1024 * 1024) {
      shown = got
      progress(`downloading ${Math.round(got / 1048576)}${total ? ` / ${Math.round(total / 1048576)}` : ""} MB`)
    }
  }
  await new Promise<void>((done, fail) => out.end((err?: Error | null) => (err ? fail(err) : done())))
  const digest = hash.digest("hex")
  if (expected && /^[0-9a-f]{64}$/.test(expected) && expected !== digest) {
    rmSync(part, { force: true })
    throw new Error(`download ${url}: SHA-256 ${digest} is not the published ${expected}`)
  }
  renameSync(part, file)
}

export const SERVICE_MODES = MODES
