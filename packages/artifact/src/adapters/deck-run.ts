// Running the slideshow project through the host runner (B3-T3).
//
// None of these functions starts a program itself; they ask the runner (B1-T5), which owns the allowlist, the
// environment, the working directory and the network. Each answer is a result: a refusal, a crash and an unparseable
// envelope all arrive as a value with the output attached, because a job that crashed is still a job to report.
//
// This is the run layer of the deck adapter: `check`, `snapshot` and `present` as the engine answers them, plus the
// envelope readers they share. It imports the project layer for two helpers and nothing else, and `deck-checks.ts`
// imports `recordOf` from here to read the same envelope. `deck.ts` decides when a run happens; nothing here decides
// that for itself.

import { mkdirSync, symlinkSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import type { HostRunInput, HostRunner, HostRunResult } from "../adapter.ts"
import { numberText, shown } from "./deck-project.ts"

// Chrome is found under `$HOME/.cache/hyperframes/chrome` (or `HYPERFRAMES_CACHE_DIR`, which the runner does not hand
// on: it is not on the sandbox's environment allowlist and a run cannot add to it). Under the runner HOME is
// `<job>/.home`, so on a machine that already has the managed headless shell, the job's cache is a link to the real one.
// A link is a directory entry inside the job and the cache behind it is only read; without it the CLI falls back to a
// system Chrome, which is slower and may not exist. A link that cannot be made is not a refusal: the run says what the
// CLI found, and that sentence is better than one this function invented.
function ensureBrowserCache(jobDir: string): void {
  const real = process.env["HYPERFRAMES_CACHE_DIR"]?.trim() || join(homedir(), ".cache", "hyperframes")
  const cache = join(real, "chrome")
  const home = join(resolve(jobDir), ".home", ".cache", "hyperframes")
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    symlinkSync(cache, join(home, "chrome"), "dir")
  } catch {
    // Already linked (EEXIST), no cache on this machine, or a host that will not make the link. The CLI resolves Chrome
    // on its own either way; this is the fast path, not a rule.
  }
}

// The JSON envelope a command prints, or nothing. The CLI writes its progress to stderr and the envelope to stdout, but
// a future version could frame it with a line, so the first object is taken rather than demanding that stdout be JSON
// from its first byte.
function envelopeOf(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

export const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// What a run said, both streams, for the message a reader gets. The whole output is kept because the JSON envelope is
// the report and the stderr tail is where a refusal that never became JSON is.
const outputOf = (result: HostRunResult): string =>
  [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n")

export interface DeckCheck {
  readonly ok: boolean
  readonly report?: unknown
  readonly output: string
  readonly refused?: string
}

// The flag that decides which GPU path the browser a check starts will take. The help says it plainly: "pass
// --no-browser-gpu for deterministic SwiftShader". Determinism is the first reason: a deck check wants the same pixels on
// every machine, so a slide's contrast, overflow and blankness are facts about the deck and not about the graphics driver
// that drew it.
//
// The second reason is this host. The auto-detected path launches `chrome-headless-shell` with
// `--use-gl=angle --use-angle=gl-egl --disable-software-rasterizer`, and that child aborts with SIGTRAP on every run: the
// user's coredump store filled with dumps that all point at our own temp job directories, and each one fires their crash
// notifier. The same command on a fresh project with this flag leaves no dump, so the hardware path is one source of the
// noise and a check avoids it by asking for software.
//
// The second, larger source was Chrome's own sandbox: inside bubblewrap it cannot build one and dies with
// `FATAL: No usable sandbox!`, one SIGTRAP per browser session. HyperFrames normally notices a container by
// `/.dockerenv` or `/run/.containerenv` and passes `--no-sandbox` itself; bwrap leaves neither marker, so the engine
// does not know. Its documented switch for exactly this is `HYPERFRAMES_CHROME_SANDBOX=0`, and passing it through the
// runner's declared-env channel turns the noise off: measured with a real deck check, two dumps before and none after,
// with the browser actually running (`browserSkipped: false`, contrast checked). Chrome without its own sandbox is
// running inside ours, which is the layering a container wants.
//
// `--no-browser-gpu` stays for the determinism it gives on its own: software rendering makes a check's pixels the same
// on every machine, which is what a visual check is worth.
const BROWSER_GPU_ARGS = ["--no-browser-gpu"] as const

// The names the adapter declares and the values its runs hand them. A name is here because a run needs it; the value is
// here because this adapter, not the host environment, knows what it should be.
export const DECK_ENV_NAMES = ["HYPERFRAMES_CHROME_SANDBOX"] as const
const DECK_ENV = { HYPERFRAMES_CHROME_SANDBOX: "0" } as const

// `hyperframes check --json` in the job directory. `ok` is the project's verdict, not the exit code's: the envelope's
// own `ok` is what says the deck is ready, and a run that exits zero while printing a failure envelope is still a
// failure. A refusal from the runner and an envelope that cannot be parsed are both `ok: false` with the reason in
// `refused`, never a throw, so a caller's report can carry the sentence.
export async function deckCheck(run: HostRunner, jobDir: string): Promise<DeckCheck> {
  ensureBrowserCache(jobDir)
  const result = await run.run({ exe: "hyperframes", args: ["check", "--json", ...BROWSER_GPU_ARGS], env: DECK_ENV })
  const output = outputOf(result)
  if (result.refused) return { ok: false, output, refused: result.refused }

  const report = envelopeOf(result.stdout)
  if (report === undefined) {
    return {
      ok: false,
      output,
      refused: `hyperframes check --json printed no JSON envelope${result.passed ? "" : ` (exit ${result.code})`}`,
    }
  }
  const verdict = recordOf(report)
  return { ok: result.passed && verdict?.["ok"] === true, report, output }
}

export interface DeckSnapshot {
  readonly shots: readonly string[]
  readonly output: string
}

// What a snapshot was asked for. `at` is the moments; `end` is the CLI's end-of-timeline frame, which is on by default
// there and off here when a caller has already named every scene. One frame per slide is the point of a per-slide
// snapshot (B3-T4): an extra frame at 47.75 s is a slide the deck does not have, and a check counting frames against
// slides would call a correct deck wrong.
export interface DeckSnapshotOptions {
  readonly at?: readonly number[]
  readonly end?: boolean
}

// `hyperframes snapshot --json`, with `--at` when the caller named the moments. The paths are what the CLI reported, in
// the form it reported them (this version prints them absolute, under the project's `.hyperframes/artifacts`), because
// rewriting a path the CLI already resolved would hide where the file really is. A refusal or an unreadable envelope
// yields no shots and the output carries the reason: there is no shot to invent.
export async function deckSnapshot(
  run: HostRunner,
  jobDir: string,
  opts: DeckSnapshotOptions = {},
): Promise<DeckSnapshot> {
  const args = ["snapshot", "--json", ...BROWSER_GPU_ARGS]
  if (opts.end === false) args.push("--no-end")
  const at = opts.at
  if (at !== undefined) {
    if (at.length === 0 || at.some((second) => !Number.isFinite(second) || second < 0)) {
      return { shots: [], output: `deck: --at takes non-negative seconds, got ${shown(at)}` }
    }
    args.push("--at", at.map(numberText).join(","))
  }

  ensureBrowserCache(jobDir)
  const result = await run.run({ exe: "hyperframes", args, env: DECK_ENV })
  const output = outputOf(result)
  if (result.refused) return { shots: [], output }

  const envelope = recordOf(envelopeOf(result.stdout))
  const frames = envelope?.["frames"]
  if (!Array.isArray(frames)) return { shots: [], output }
  const shots: string[] = []
  for (const frame of frames) {
    const path = recordOf(frame)?.["path"]
    if (typeof path === "string" && path.length > 0) shots.push(path)
  }
  return { shots, output }
}

export interface DeckPresent {
  readonly started: boolean
  readonly output: string
}

// How long the presenter is given to answer and how often the port is tried. The server is a few hundred milliseconds
// on this machine; twelve seconds is generous for a cold start and short enough that a broken run fails a test instead
// of hanging it.
const PRESENT_START_MS = 12_000
const PRESENT_POLL_MS = 100
const PRESENT_CONNECT_MS = 400

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// Whether something accepts a TCP connection on the port. The presenter's page is a normal HTTP server, so a connection
// is the cheapest proof it is up; the caller fetches the page itself when it wants the body.
function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port })
    let finished = false
    const finish = (answer: boolean): void => {
      if (finished) return
      finished = true
      socket.destroy()
      done(answer)
    }
    socket.setTimeout(PRESENT_CONNECT_MS, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

// `hyperframes present <job> --no-open --port <port>`, returned once the port answers. The run itself is not awaited:
// the runner is one-run-at-a-time by design, so a presented deck occupies it until the caller calls `run.cancel()`, and
// a function that awaited the server would never return. That is the contract the adapter relies on — the presenter is
// the job's foreground, and cancelling it is how the job ends.
//
// The job is presented with the network declaration its runner was built with. A presenter is a local HTTP server that
// the user's browser has to reach, so a runner with the network unshared can start it but nothing outside its namespace
// can open the page; the caller that wants to look at a deck builds that runner with the network shared.
//
// On a timeout the run is cancelled here, because a caller that got `started: false` has no process to cancel and the
// runner would otherwise stay busy. On a refusal nothing is started and the sentence is the output.
export async function deckPresent(run: HostRunner, jobDir: string, port: number): Promise<DeckPresent> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { started: false, output: `deck: port ${shown(port)} is not a TCP port` }
  }

  // The presenter's server listens inside the child's namespace, so it is reachable from the user's browser only when
  // the run asks for the host network. Every other call this adapter makes leaves it out and stays wrapped.
  const input: HostRunInput = {
    exe: "hyperframes",
    args: ["present", resolve(jobDir), "--no-open", "--port", String(port)],
    network: true,
  }
  let settled: HostRunResult | undefined
  let failed: string | undefined
  // Both halves are handled, so the promise this function leaves behind can never become an unhandled rejection: the run
  // resolves when the caller cancels, and a runner that throws instead is still a start that did not happen.
  const pending = run.run(input).then(
    (result) => {
      settled = result
      return result
    },
    (error: unknown) => {
      failed = error instanceof Error ? error.message : String(error)
      return undefined
    },
  )

  const deadline = Date.now() + PRESENT_START_MS
  while (Date.now() < deadline && settled === undefined && failed === undefined) {
    if (await portAnswers(port)) return { started: true, output: `hyperframes present is listening on port ${port}` }
    await wait(PRESENT_POLL_MS)
  }

  if (settled === undefined && failed === undefined) {
    // The port never answered and the process is still alive: stop it so the runner is free, then report what it said.
    run.cancel()
  }
  const result = settled ?? (await pending)
  const said = result ? outputOf(result) : ""
  const why =
    failed ??
    result?.refused ??
    (result?.cancelled ? "the presenter was stopped before it answered" : `the presenter did not answer on port ${port}`)
  return { started: false, output: said ? `${why}\n${said}` : why }
}
