// The local services on a host (roadmap A6, the 1.0 cut): the decider and the memory's embedding service, run by the
// supervisor (@omacode/core/supervisor) as one user service, `omacode-services`. The supervisor starts a service on its
// first request, stops it after ten idle minutes and starts it again on the next one, so a laptop does not keep two
// models in memory nobody asks; its fronts listen on the services' usual ports (8781, 8093) behind a token, and the
// plugin finds the token in $XDG_RUNTIME_DIR/omacode (@omacode/core/services).
//
//   omacode services install [--embedding 0.6b|4b|8b] [--replace]   copy the decider, sync it, write and start the unit
//   omacode services status                                          what runs, from the supervisor's status file
//   omacode services remove [--purge]                                stop and remove the unit; --purge also the files
//
// Nothing a model needs is downloaded at install time: the decider's weights come on its first start (from Hugging
// Face, or the tuned checkpoint shipped in the plugin's decider/models/), the embedding weights the same way unless a
// file of the size is already on the machine.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { userDataDir } from "@omacode/core/paths"
import { runDir } from "@omacode/core/services"

import type { Exec } from "./worktree/git.ts"

export const UNIT = "omacode-services"
export const PORTS = { decider: 8781, embedding: 8093 } as const
export const EMBEDDING_SIZES = { "0.6b": "0.6B", "4b": "4B", "8b": "8B" } as const
export type EmbeddingSize = keyof typeof EMBEDDING_SIZES
// The services this replaces: what install.sh and decider/decider.service set up before A6.
export const OLD_UNITS = ["decider", "micromanager-embedding"] as const
// The decider before the tuned one, for a plugin that ships no checkpoint.
export const BASE_DECIDER_MODEL = "fastino/GLiNER2.5-multi-Decide"

export interface ServicesConfig {
  readonly decider: { readonly bin: string; readonly model: string }
  readonly embedding: { readonly server: readonly string[]; readonly gguf: string; readonly url: string; readonly model: string }
  readonly modes?: Readonly<Record<string, "on" | "auto" | "off">>
  readonly idleMinutes?: number
}

// Where the installed services live: the decider's copy and its environment, the model files, the config the
// supervisor reads. Under the user's data directory, so `remove --purge` knows what is its own.
export function servicesHome(): string {
  return join(userDataDir(), "services")
}
export const configPath = (home = servicesHome()): string => join(home, "config.json")

// The plugin's own decider/ directory: beside packages/ in a checkout and in the installed package alike.
export function deciderSource(): string {
  return resolve(import.meta.dirname, "..", "..", "..", "decider")
}

// The newest tuned checkpoint the plugin ships (decider/models/<name>/model.safetensors), if any.
export function shippedModel(source = deciderSource()): string | undefined {
  const dir = join(source, "models")
  if (!existsSync(dir)) return undefined
  const names = readdirSync(dir).filter((n) => existsSync(join(dir, n, "model.safetensors"))).sort()
  return names.length ? names[names.length - 1] : undefined
}

// The llama.cpp server: LLAMA_SERVER as a command line, llama-server on PATH, or the llama-vulkan build's serve verb
// (what install.sh used). As argv, never a shell string.
export function findLlamaServer(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if (env.LLAMA_SERVER?.trim()) return env.LLAMA_SERVER.trim().split(/\s+/)
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const file = join(dir, "llama-server")
    if (isExecutable(file)) return [file]
  }
  const vulkan = join(env.HOME || homedir(), ".local", "bin", "llama-vulkan")
  return isExecutable(vulkan) ? [vulkan, "serve"] : undefined
}

function isExecutable(file: string): boolean {
  try {
    const info = statSync(file)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

// An embedding file of this size already on the machine (install.sh put them under ~/Models/gguf), else the place a
// first start downloads it to.
export function ggufFor(size: EmbeddingSize, home = servicesHome(), env: NodeJS.ProcessEnv = process.env): { path: string; present: boolean } {
  const name = `Qwen3-Embedding-${EMBEDDING_SIZES[size]}-Q8_0.gguf`
  const dir = `qwen3-embedding-${size}`
  const old = join(env.MICROMANAGER_MODELS || join(env.HOME || homedir(), "Models", "gguf"), dir, name)
  if (existsSync(old)) return { path: old, present: true }
  const own = join(home, "models", dir, name)
  return { path: own, present: existsSync(own) }
}

export const embeddingUrl = (size: EmbeddingSize): string =>
  `https://huggingface.co/Qwen/Qwen3-Embedding-${EMBEDDING_SIZES[size]}-GGUF/resolve/main/Qwen3-Embedding-${EMBEDDING_SIZES[size]}-Q8_0.gguf`

// ---------------------------------------------------------------------------------------------------------------------
// The unit files. Both run the supervisor with the node that runs this command, so a version manager's node keeps
// working after a reboot, and both name nothing of the user's checkout but the plugin's own entry file.

export function supervisorEntry(): string {
  return resolve(import.meta.dirname, "services-main.ts")
}

export function systemdUnit(node: string, entry: string, home: string): string {
  return `# Written by \`omacode services install\` (packages/micromanager/src/services.ts); \`omacode services remove\` takes it away.
[Unit]
Description=Omacode local services: decider and memory embeddings, started on demand

[Service]
Environment=OMACODE_SERVICES_HOME=${home}
Environment=OMACODE_RUN_DIR=%t/omacode
Environment=CUDA_VISIBLE_DEVICES=
ExecStart=${node} ${entry}
Restart=on-failure
RestartSec=5
# The decider peaked at 2.6 GB and a 4B embedding model takes about 5 GB; past this the unit is restarted instead of
# pushing the desktop into swap.
MemoryMax=10G
MemorySwapMax=0

[Install]
WantedBy=default.target
`
}

export function launchdPlist(node: string, entry: string, home: string, runDirPath: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.omacode.services</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(entry)}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>OMACODE_SERVICES_HOME</key><string>${esc(home)}</string>
    <key>OMACODE_RUN_DIR</key><string>${esc(runDirPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`
}

export function unitPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir()
  return platform === "darwin"
    ? join(home, "Library", "LaunchAgents", "dev.omacode.services.plist")
    : join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", `${UNIT}.service`)
}

// ---------------------------------------------------------------------------------------------------------------------
// install, status, remove.

export interface InstallOptions {
  readonly embedding?: EmbeddingSize
  readonly replace?: boolean
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly source?: string
  readonly node?: string
  readonly log?: (line: string) => void
}

const ok = (r: { code: number }) => r.code === 0

// Which of the old units exist on this machine, so install can say what it would replace.
export async function oldUnits(run: Exec, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dir = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd", "user")
  return OLD_UNITS.filter((u) => existsSync(join(dir, `${u}.service`)))
}

export async function install(run: Exec, o: InstallOptions = {}): Promise<{ ok: boolean; text: string }> {
  const log = o.log ?? (() => {})
  const env = o.env ?? process.env
  const platform = o.platform ?? process.platform
  const home = o.home ?? servicesHome()
  const source = o.source ?? deciderSource()
  const node = o.node ?? process.execPath
  const lines: string[] = []
  const say = (line: string) => {
    lines.push(line)
    log(line)
  }

  // Preflight: what has to be there before anything is written.
  if (!existsSync(join(source, "uv.lock"))) return { ok: false, text: `the plugin's decider is not at ${source} (no uv.lock)` }
  if (!ok(await run("uv", ["--version"], { cwd: process.cwd() }).catch(() => ({ code: 1 })))) {
    return { ok: false, text: "uv is not installed; the decider's environment is made with it: https://docs.astral.sh/uv/getting-started/installation/" }
  }
  const old = platform === "linux" ? await oldUnits(run, env) : []
  if (old.length && !o.replace) {
    return { ok: false, text: `this machine runs ${old.map((u) => `${u}.service`).join(" and ")} on the same ports; run again with --replace to stop and disable them (their files stay)` }
  }

  // The decider: a copy of the plugin's decider/ without its environments, then its own environment from the lock.
  const decider = join(home, "decider")
  mkdirSync(home, { recursive: true })
  rmSync(decider, { recursive: true, force: true })
  cpSync(source, decider, { recursive: true, filter: (from) => !/\/(\.venv|train|tests|__pycache__|runs)(\/|$)/.test(from.slice(source.length)) })
  say(`copied the decider to ${decider}`)
  const synced = await run("uv", ["sync", "--frozen", "--no-dev"], { cwd: decider, timeoutMs: 30 * 60_000 })
  if (!ok(synced)) return { ok: false, text: `uv sync failed in ${decider}: ${synced.stderr.trim().slice(-500)}` }
  const shipped = shippedModel(decider)
  const model = shipped ? join(decider, "models", shipped) : BASE_DECIDER_MODEL
  say(`decider model: ${shipped ? `the tuned ${shipped}` : `${BASE_DECIDER_MODEL}, downloaded on its first start`}`)

  // The embedding service: a size already on the machine wins over the default, so stored vectors keep their model.
  const size: EmbeddingSize = o.embedding ?? ((["4b", "8b", "0.6b"] as const).find((s) => ggufFor(s, home, env).present) ?? "0.6b")
  const gguf = ggufFor(size, home, env)
  const server = findLlamaServer(env)
  if (!server) say("no llama.cpp server found (llama-server on PATH, or LLAMA_SERVER): memory search runs on keywords until one is installed")
  say(`embedding: Qwen3-Embedding-${EMBEDDING_SIZES[size]}${gguf.present ? ` from ${gguf.path}` : ", downloaded on its first start"}`)

  const config: ServicesConfig = {
    decider: { bin: join(decider, ".venv", "bin", "decider"), model },
    embedding: { server: server ?? [], gguf: gguf.path, url: embeddingUrl(size), model: `qwen3-embedding-${size}` },
    modes: { decider: "auto", embedding: server ? "auto" : "off" },
    idleMinutes: 10,
  }
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })

  // The unit, and the old units out of the way.
  const unit = unitPath(platform, env)
  mkdirSync(dirname(unit), { recursive: true })
  const entry = supervisorEntry()
  if (platform === "darwin") {
    writeFileSync(unit, launchdPlist(node, entry, home, join(env.TMPDIR || "/tmp", "omacode")))
    await run("launchctl", ["unload", unit], { cwd: home }).catch(() => undefined)
    const loaded = await run("launchctl", ["load", "-w", unit], { cwd: home })
    if (!ok(loaded)) return { ok: false, text: `launchctl load failed: ${loaded.stderr.trim()}` }
  } else {
    for (const u of old) {
      await run("systemctl", ["--user", "disable", "--now", `${u}.service`], { cwd: home })
      say(`stopped and disabled ${u}.service (its file stays)`)
    }
    writeFileSync(unit, systemdUnit(node, entry, home))
    await run("systemctl", ["--user", "daemon-reload"], { cwd: home })
    const started = await run("systemctl", ["--user", "enable", "--now", `${UNIT}.service`], { cwd: home })
    if (!ok(started)) return { ok: false, text: `systemctl could not start ${UNIT}: ${started.stderr.trim()}` }
  }
  say(`${UNIT} runs; the decider listens on ${PORTS.decider}, the embedding service on ${PORTS.embedding}, each started on its first request`)
  return { ok: true, text: lines.join("\n") }
}

export function status(env: NodeJS.ProcessEnv = process.env): string {
  const file = join(runDir(env), "status.json")
  if (!existsSync(file)) return `${UNIT} is not running (no ${file})`
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { updated?: string; services?: Record<string, { mode?: string; state?: string; url?: string; detail?: string }> }
    return Object.entries(s.services ?? {}).map(([name, v]) => `${name}: ${v.mode ?? "?"} · ${v.state ?? "?"} · ${v.url ?? ""}${v.detail ? ` · ${v.detail}` : ""}`).join("\n") + `\n(as of ${s.updated ?? "?"})`
  } catch {
    return `${file} cannot be read`
  }
}

export async function remove(run: Exec, o: { purge?: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<string> {
  const platform = o.platform ?? process.platform
  const unit = unitPath(platform, o.env)
  const home = o.home ?? servicesHome()
  if (platform === "darwin") await run("launchctl", ["unload", "-w", unit], { cwd: dirname(unit) }).catch(() => undefined)
  else await run("systemctl", ["--user", "disable", "--now", `${UNIT}.service`], { cwd: dirname(unit) }).catch(() => undefined)
  rmSync(unit, { force: true })
  if (platform !== "darwin") await run("systemctl", ["--user", "daemon-reload"], { cwd: dirname(unit) }).catch(() => undefined)
  if (o.purge) {
    rmSync(home, { recursive: true, force: true })
    return `removed ${UNIT} and ${home}`
  }
  return `removed ${UNIT}; the decider's copy and the downloaded models stay in ${home} (--purge removes them)`
}
