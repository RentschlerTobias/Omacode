// The host install around the plugin (roadmap A6, slimmed for 1.0): a preflight before anything is written, the
// profiles install.sh offers, `doctor` for a machine that already has omacode, and the uninstall plan. install.sh is the
// front door and only calls these through the CLI, so every decision here is plain data a test can read.
//
//   omacode preflight          what this machine has and lacks, before an install
//   omacode setup <profile>    install what a profile names (services, creative tools); `setup ask` asks which
//   omacode doctor             the installed state, each finding with its fix
//   omacode uninstall [--purge] [--dry-run]   remove what the install made, and say what stays
//
// Nothing here downloads on its own: a profile says what it would fetch and how large it is before it runs.

import { existsSync, lstatSync, readFileSync, readlinkSync, statfsSync } from "node:fs"
import { totalmem } from "node:os"
import { join } from "node:path"

import { findChromium } from "@omacode/artifact/chromium"
import { stripComments } from "@omacode/core/jsonc"
import { configFilePath, userConfigDir, userDataDir, userStateDir } from "@omacode/core/paths"

import { comfyMcpConfigured } from "./comfy-gate.ts"
import { PINS, TOOL_INFO, type Found, type ToolName } from "./creative-tools.ts"
import type { Exec } from "./worktree/git.ts"

export type Level = "ok" | "warn" | "fail" | "info"

export interface Check {
  readonly area: string
  readonly level: Level
  readonly text: string
  readonly fix?: string
}

// What a check may ask of the machine; tests hand in their own.
export interface Probe {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly node: string
  readonly totalMem: number
  readonly env: NodeJS.ProcessEnv
  readonly run: Exec
  freeBytes(dir: string): number | undefined
  which(name: string): string | undefined
}

export function realProbe(run: Exec, env: NodeJS.ProcessEnv = process.env): Probe {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    totalMem: totalmem(),
    env,
    run,
    freeBytes(dir) {
      try {
        const s = statfsSync(dir)
        return s.bavail * s.bsize
      } catch {
        return undefined
      }
    },
    which(name) {
      for (const d of (env["PATH"] ?? "").split(":").filter(Boolean)) {
        const file = join(d, name)
        try {
          if (lstatSync(file)) return file
        } catch {
          // not here
        }
      }
      return undefined
    },
  }
}

// The Node the plugin's packages declare (engines), and the OpenCode it is tested against.
export const MIN_NODE = "22.18.0"
export const TESTED_OPENCODE = "2.2.5"
const GB = 1024 ** 3

const newer = (a: string, b: string): number => {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

const versionOf = async (p: Probe, cmd: string, args: string[]): Promise<string | undefined> => {
  const r = await p.run(cmd, args, { cwd: p.env["HOME"] ?? "/", timeoutMs: 20_000 }).catch(() => undefined)
  return r && r.code === 0 ? /\bv?(\d+\.\d+(?:\.\d+)?)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] : undefined
}

// What the machine has before an install. A "fail" stops install.sh; a "warn" names what will not work.
export async function preflight(p: Probe): Promise<Check[]> {
  const out: Check[] = []
  if (p.platform === "linux") out.push({ area: "system", level: "ok", text: `Linux ${p.arch}` })
  else if (p.platform === "darwin") out.push({ area: "system", level: "warn", text: `macOS ${p.arch}: the plugin and the services run; the sandbox for plan mode and the artifact runner need Linux (bubblewrap)` })
  else out.push({ area: "system", level: "fail", text: `${p.platform} is not supported (Linux, or macOS with limits)` })

  out.push(newer(p.node, MIN_NODE) >= 0
    ? { area: "node", level: "ok", text: `Node ${p.node}` }
    : { area: "node", level: "fail", text: `Node ${p.node} is older than ${MIN_NODE}`, fix: `install Node ${MIN_NODE} or newer` })

  const oc = await versionOf(p, "opencode", ["--version"])
  if (!oc) out.push({ area: "opencode", level: "fail", text: "OpenCode is not installed", fix: "install it: https://opencode.ai" })
  else if (newer(oc, TESTED_OPENCODE) < 0) out.push({ area: "opencode", level: "warn", text: `OpenCode ${oc} is older than ${TESTED_OPENCODE}, the version omacode is tested with`, fix: "opencode upgrade" })
  else out.push({ area: "opencode", level: "ok", text: `OpenCode ${oc}` })

  const tools: { name: string; area: string; why: string; level: Level }[] = [
    { name: "git", area: "git", why: "micromanager jobs work in git worktrees", level: "warn" },
    { name: "uv", area: "uv", why: "the decider service, ComfyUI, Manim and comfy-mcp are installed with it", level: "warn" },
    { name: "ffmpeg", area: "ffmpeg", why: "videos are encoded with it", level: "info" },
  ]
  if (p.platform === "linux") tools.push({ name: "bwrap", area: "bwrap", why: "plan mode's sandbox and the artifact runner use bubblewrap", level: "warn" })
  for (const t of tools) {
    const where = p.which(t.name)
    out.push(where ? { area: t.area, level: "ok", text: `${t.name} found` } : { area: t.area, level: t.level, text: `${t.name} not found: ${t.why}`, fix: `install ${t.name === "bwrap" ? "bubblewrap" : t.name}` })
  }
  const chromium = findChromium(p.env)
  out.push(chromium ? { area: "browser", level: "ok", text: `Chromium found (${chromium})` } : { area: "browser", level: "warn", text: "no Chromium: the deck and site checks that open a browser are skipped", fix: "install chromium" })

  const ram = p.totalMem / GB
  out.push(ram >= 8 ? { area: "memory", level: "ok", text: `${ram.toFixed(0)} GB RAM` } : { area: "memory", level: "warn", text: `${ram.toFixed(1)} GB RAM: the local services want about 4 GB free` })
  const free = p.freeBytes(existsSync(userDataDir()) ? userDataDir() : (p.env["HOME"] ?? "/"))
  if (free !== undefined) out.push(free >= 5 * GB ? { area: "disk", level: "ok", text: `${(free / GB).toFixed(0)} GB free` } : { area: "disk", level: "warn", text: `${(free / GB).toFixed(1)} GB free: the Coding profile needs about 3 GB, Creator about 10 GB` })
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// What install.sh installs. Required: what the plugin cannot run without; a missing one is installed after one
// question. Optional: each part asked on its own, with what it is for and what it downloads; a part that needs uv
// brings uv along. A profile is the same answers given up front.

export type Manager = "pacman" | "apt" | "dnf" | "brew"
export type SystemNeed = "git" | "bubblewrap" | "chromium" | "ffmpeg" | "uv" | "node"

// The package of each need per package manager. A need a manager does not carry is installed another way (uv) or
// named for the user to install (Node on apt, whose nodejs is older than the plugin needs).
export const PACKAGES: Readonly<Record<Manager, Partial<Record<SystemNeed, string>>>> = {
  pacman: { git: "git", bubblewrap: "bubblewrap", chromium: "chromium", ffmpeg: "ffmpeg", uv: "uv", node: "nodejs npm" },
  apt: { git: "git", bubblewrap: "bubblewrap", chromium: "chromium", ffmpeg: "ffmpeg" },
  dnf: { git: "git", bubblewrap: "bubblewrap", chromium: "chromium", ffmpeg: "ffmpeg-free", uv: "uv", node: "nodejs" },
  brew: { git: "git", ffmpeg: "ffmpeg", uv: "uv", node: "node" },
}

// uv's own installer where the package manager has no uv, pinned to a release older than two weeks (2026-10-20).
export const UV_PIN = "0.13.4"

export function packageManager(p: Pick<Probe, "which" | "platform">): Manager | undefined {
  if (p.platform === "darwin") return p.which("brew") ? "brew" : undefined
  if (p.which("pacman")) return "pacman"
  if (p.which("apt-get")) return "apt"
  if (p.which("dnf")) return "dnf"
  return undefined
}

export interface Command {
  readonly say: string
  readonly cmd: string
  readonly args: readonly string[]
}

// The commands that install system needs, and what is left for the user to install by hand.
export function systemInstall(manager: Manager | undefined, needs: readonly SystemNeed[]): { commands: Command[]; manual: string[] } {
  const commands: Command[] = []
  const manual: string[] = []
  const packages: string[] = []
  for (const need of [...new Set(needs)]) {
    const pkg = manager ? PACKAGES[manager][need] : undefined
    if (pkg) packages.push(...pkg.split(" "))
    else if (need === "uv") commands.push({ say: `uv ${UV_PIN} with its own installer (astral.sh)`, cmd: "sh", args: ["-c", `curl -LsSf https://astral.sh/uv/${UV_PIN}/install.sh | sh`] })
    else if (need === "node") manual.push("Node 22.18 or newer: https://nodejs.org (your package manager's is older)")
    else manual.push(`${need}: install it with your package manager`)
  }
  if (packages.length) {
    const sudo = (cmd: string, args: string[]): Command => ({ say: `${manager}: ${packages.join(" ")}`, cmd: "sudo", args: [cmd, ...args] })
    if (manager === "pacman") commands.unshift(sudo("pacman", ["-S", "--needed", "--noconfirm", ...packages]))
    else if (manager === "apt") commands.unshift(sudo("apt-get", ["install", "-y", ...packages]))
    else if (manager === "dnf") commands.unshift(sudo("dnf", ["install", "-y", ...packages]))
    else if (manager === "brew") commands.unshift({ say: `brew: ${packages.join(" ")}`, cmd: "brew", args: ["install", ...packages] })
  }
  return { commands, manual }
}

export const OPENCODE_INSTALL: Command = { say: "OpenCode with its own installer (opencode.ai)", cmd: "sh", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] }

// What the plugin cannot run without (Node is checked by install.sh itself, before any of this runs).
export function requiredNeeds(p: Pick<Probe, "which" | "platform">): SystemNeed[] {
  const needs: SystemNeed[] = []
  if (!p.which("git")) needs.push("git")
  if (p.platform === "linux" && !p.which("bwrap")) needs.push("bubblewrap")
  return needs
}

export const OFFER_IDS = ["services", "chromium", "ffmpeg", "hyperframes", "comfyui", "comfy-mcp", "manim"] as const
export type OfferId = (typeof OFFER_IDS)[number]

export interface Offer {
  readonly title: string
  readonly what: string
  readonly size: string
  // SPDX, as in licenses/components.json (a test keeps the two the same)
  readonly licence: string
  // a system package this is, a creative tool this is, or the services
  readonly system?: SystemNeed
  readonly tool?: ToolName
  readonly needsUv?: boolean
  // only offered when this other part is there or chosen
  readonly after?: OfferId
}

export const OFFERS: Readonly<Record<OfferId, Offer>> = {
  services: { title: "Local services", what: "a decider on this machine answers the guards' questions, and memory searches by meaning (omacode-services)", size: "about 2 GB now, the models on first use", licence: "Apache-2.0 (decider and models)", needsUv: true },
  chromium: { title: "Chromium", what: "the deck and site checks open the result in a real browser", size: "about 300 MB", licence: "BSD-3-Clause and others", system: "chromium" },
  ffmpeg: { title: "ffmpeg", what: "videos are encoded with it", size: "about 100 MB", licence: "LGPL-2.1-or-later or GPL, by build", system: "ffmpeg" },
  hyperframes: { title: TOOL_INFO.hyperframes.title, what: TOOL_INFO.hyperframes.what, size: TOOL_INFO.hyperframes.size, licence: "Apache-2.0", tool: "hyperframes" },
  comfyui: { title: TOOL_INFO.comfyui.title, what: TOOL_INFO.comfyui.what, size: TOOL_INFO.comfyui.size, licence: "GPL-3.0-only", tool: "comfyui", needsUv: true },
  "comfy-mcp": { title: TOOL_INFO["comfy-mcp"].title, what: TOOL_INFO["comfy-mcp"].what, size: TOOL_INFO["comfy-mcp"].size, licence: "AGPL-3.0-or-later OR LicenseRef-Comfy-Commercial", tool: "comfy-mcp", needsUv: true, after: "comfyui" },
  manim: { title: TOOL_INFO.manim.title, what: TOOL_INFO.manim.what, size: TOOL_INFO.manim.size, licence: "MIT", tool: "manim", needsUv: true },
}

// What is already on the machine, so it is not offered again.
export interface Present {
  readonly services: boolean
  readonly which: (name: string) => string | undefined
  readonly chromium: boolean
  readonly tools: readonly Found[]
}

export function isPresent(id: OfferId, there: Present): boolean {
  const offer = OFFERS[id]
  if (id === "services") return there.services
  if (id === "chromium") return there.chromium
  if (offer.system) return Boolean(there.which(offer.system))
  return there.tools.some((t) => t.name === offer.tool && t.found)
}

export interface Plan {
  readonly system: readonly SystemNeed[]
  readonly services: boolean
  readonly tools: readonly ToolName[]
}

// The answers turned into what to install: parts already there are dropped, a part offered only after another one is
// dropped without it, and uv is added when a chosen part needs it and it is missing.
export function planFor(chosen: readonly OfferId[], there: Present): Plan {
  const wanted = OFFER_IDS.filter((id) => chosen.includes(id) && !isPresent(id, there))
  const kept = wanted.filter((id) => {
    const after = OFFERS[id].after
    return !after || isPresent(after, there) || wanted.includes(after)
  })
  const system: SystemNeed[] = kept.map((id) => OFFERS[id].system).filter((x): x is SystemNeed => Boolean(x))
  if (kept.some((id) => OFFERS[id].needsUv) && !there.which("uv")) system.unshift("uv")
  return {
    system,
    services: kept.includes("services"),
    tools: kept.map((id) => OFFERS[id].tool).filter((x): x is ToolName => Boolean(x)),
  }
}

// What an artifact kind cannot be made without, found on PATH only (fast, before a build). A deck and a video are made by
// HyperFrames; a video is also encoded with ffmpeg. Sites and images have fallbacks (a skipped browser check, the cloud
// image tool), so they are not blocked here.
export const NEEDS_BY_KIND: Readonly<Record<string, readonly OfferId[]>> = { deck: ["hyperframes"], video: ["hyperframes", "ffmpeg"] }

export function missingForKind(kind: string, which: (name: string) => string | undefined): OfferId[] {
  return (NEEDS_BY_KIND[kind] ?? []).filter((id) => !which(OFFERS[id].system ?? OFFERS[id].tool ?? id))
}

// What the agent is told when a part is missing: ask the user, then install_feature for a part in user space; the
// terminal command for a system package, which needs sudo.
export function missingNote(what: string, missing: readonly OfferId[]): string {
  const lines = missing.map((id) => {
    const o = OFFERS[id]
    return o.system
      ? `- ${o.title} (${o.what}) is a system package: ask the user to run ./install.sh --with ${id} in a terminal (it needs sudo), then build again.`
      : `- ${o.title} (${o.what}; ${o.size}): ask the user whether to install it; if yes, call install_feature with part "${id}", then build again.`
  })
  return [`${what} cannot be made yet; missing:`, ...lines].join("\n")
}

// Profiles: the same answers given up front (install.sh --profile).
export const PROFILE_IDS = ["minimal", "coding", "creator", "full"] as const
export type ProfileId = (typeof PROFILE_IDS)[number]

export interface Profile {
  readonly title: string
  readonly offers: readonly OfferId[]
  readonly download: string
}

export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
  minimal: { title: "Minimal", offers: [], download: "nothing" },
  coding: { title: "Coding", offers: ["services"], download: "about 2 GB, models on first use" },
  creator: { title: "Creator", offers: ["services", "chromium", "ffmpeg", "hyperframes", "comfyui", "comfy-mcp"], download: "about 8–12 GB" },
  full: { title: "Full", offers: ["services", "chromium", "ffmpeg", "hyperframes", "comfyui", "comfy-mcp", "manim"], download: "about 8–12 GB" },
}

// ---------------------------------------------------------------------------------------------------------------------
// Doctor: the installed state.

export interface Paths {
  readonly opencodeDir: string
  readonly pluginLink: string
  readonly tuiDir: string
  readonly cliJson: string
  readonly opencodeJson: string
  readonly config: string
  readonly data: string
  readonly state: string
  readonly unit: string
}

export function paths(unit: string, opencodeDir = userConfigDir()): Paths {
  return {
    opencodeDir,
    pluginLink: join(opencodeDir, "plugins", "omacode.ts"),
    tuiDir: join(opencodeDir, "omacode-tui"),
    cliJson: join(opencodeDir, "cli.json"),
    opencodeJson: join(opencodeDir, "opencode.json"),
    config: configFilePath(opencodeDir),
    data: userDataDir(),
    state: userStateDir(),
    unit,
  }
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(stripComments(readFileSync(file, "utf8"))) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const pluginEntries = (config: Record<string, unknown> | undefined): string[] => {
  const list = config?.["plugins"] ?? config?.["plugin"]
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
}

export function pluginChecks(at: Paths): Check[] {
  const out: Check[] = []
  let linked: string | undefined
  try {
    if (lstatSync(at.pluginLink).isSymbolicLink()) linked = readlinkSync(at.pluginLink)
  } catch {
    linked = undefined
  }
  const packages = pluginEntries(readJson(at.opencodeJson)).filter((p) => /omacode|micromanager/i.test(p))
  if (linked !== undefined) {
    out.push(existsSync(at.pluginLink)
      ? { area: "plugin", level: "ok", text: `linked from a checkout: ${linked}` }
      : { area: "plugin", level: "fail", text: `${at.pluginLink} points at ${linked}, which is gone`, fix: "run ./install.sh in the checkout again, or ./install.sh --remove" })
  }
  for (const p of packages) out.push({ area: "plugin", level: "info", text: `also listed in opencode.json: ${p} (each part registers once, so this is harmless)` })
  if (linked === undefined && packages.length === 0) out.push({ area: "plugin", level: "fail", text: "the plugin is not installed", fix: "./install.sh in a checkout, or: opencode plugin add @omacode/full" })

  const tui = pluginEntries(readJson(at.cliJson)).includes(at.tuiDir) && existsSync(join(at.tuiDir, "tui.tsx"))
  out.push(tui ? { area: "tui", level: "ok", text: "the TUI package is installed" } : { area: "tui", level: "warn", text: "the TUI package is not installed: no progress line, sidebar sections or /first-deck", fix: "./install.sh" })

  const raw = existsSync(at.config) ? readFileSync(at.config, "utf8") : undefined
  if (raw === undefined) out.push({ area: "config", level: "info", text: `no ${at.config}: the defaults apply` })
  else {
    try {
      JSON.parse(stripComments(raw))
      out.push({ area: "config", level: "ok", text: `${at.config} reads` })
    } catch (err) {
      out.push({ area: "config", level: "fail", text: `${at.config} does not parse: ${err instanceof Error ? err.message : String(err)}`, fix: "fix the file; until then the plugin runs on its defaults" })
    }
  }
  return out
}

export function toolChecks(found: readonly Found[], opencodeJson: string): Check[] {
  const pin: Partial<Record<ToolName, string>> = { hyperframes: PINS.hyperframes, manim: PINS.manim, comfyui: PINS.comfyui, "comfy-mcp": PINS.comfyMcp }
  const out: Check[] = []
  for (const f of found) {
    const title = TOOL_INFO[f.name].title
    if (!f.found) {
      out.push({ area: f.name, level: "info", text: `${title} not installed: ${TOOL_INFO[f.name].what}`, fix: `./install.sh --with ${f.name}` })
      continue
    }
    const want = pin[f.name]
    out.push(want && f.version && f.version !== want
      ? { area: f.name, level: "warn", text: `${title} ${f.version}; omacode is tested with ${want}`, fix: `./install.sh --with ${f.name}` }
      : { area: f.name, level: "ok", text: `${title} ${f.version ?? ""}${f.where ? ` in ${f.where}` : ""}`.trim() })
  }
  const mcp = found.find((f) => f.name === "comfy-mcp")
  if (mcp?.found && !comfyMcpConfigured(readJson(opencodeJson))) {
    out.push({ area: "comfy-mcp", level: "warn", text: "comfy-mcp is installed but OpenCode does not start it", fix: "./install.sh --with comfy-mcp adds it to opencode.json" })
  }
  return out
}

// The services unit and the sandbox, asked of the machine.
export async function machineChecks(p: Probe, at: Paths): Promise<Check[]> {
  const out: Check[] = []
  const cwd = p.env["HOME"] ?? "/"
  if (!existsSync(at.unit)) {
    out.push({ area: "services", level: "info", text: "omacode-services is not installed: questions go to you (or a cloud decider), memory searches by keywords", fix: "npm run services -- install" })
  } else if (p.platform === "linux") {
    const active = await p.run("systemctl", ["--user", "is-active", "omacode-services.service"], { cwd }).catch(() => undefined)
    out.push(active?.stdout.trim() === "active"
      ? { area: "services", level: "ok", text: "omacode-services runs (/services in the TUI switches each service)" }
      : { area: "services", level: "warn", text: `omacode-services is installed but ${active?.stdout.trim() || "not running"}`, fix: "systemctl --user restart omacode-services; journalctl --user -u omacode-services says why it stopped" })
  } else {
    out.push({ area: "services", level: "ok", text: `omacode-services is installed (${at.unit})` })
  }
  if (p.platform === "linux") {
    const box = await p.run("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { cwd, timeoutMs: 15_000 }).catch(() => undefined)
    out.push(box?.code === 0
      ? { area: "sandbox", level: "ok", text: "bubblewrap runs: plan mode and the artifact runner can sandbox" }
      : { area: "sandbox", level: "fail", text: `bubblewrap does not run here${box?.stderr ? `: ${box.stderr.trim().slice(0, 200)}` : ""}; plan mode falls back to asking`, fix: "install bubblewrap and allow unprivileged user namespaces" })
  }
  const hf = p.which("hyperframes")
  if (hf) {
    const doc = await p.run("hyperframes", ["doctor"], { cwd, timeoutMs: 60_000 }).catch(() => undefined)
    // Only the checks a deck or a video needs. The rest of HyperFrames' doctor is optional (a transcriber, a local
    // voice, music, Docker for `render --docker`) or a newer release, which omacode does not want: it pins the version
    // it is tested with. Its exit code counts those too, so the lines are read instead.
    const tail = (doc ? `${doc.stdout}\n${doc.stderr}` : "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim())
      .filter((l) => /^✗\s*(CLI binary|Node\.js|Memory|Disk|Frames cache|\/dev\/shm|FFmpeg|FFprobe|Chrome)\b/.test(l))
      .slice(0, 4)
    out.push(doc && tail.length === 0
      ? { area: "hyperframes", level: "ok", text: "hyperframes doctor: everything decks and videos need is there" }
      : { area: "hyperframes", level: "warn", text: `hyperframes doctor: ${tail.join("; ") || `exited with ${doc?.code ?? "no answer"}`}`, fix: "hyperframes doctor (optional extras such as a transcriber are not needed for decks)" })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Uninstall: what goes and what stays, said before anything is removed.

export interface UninstallPlan {
  readonly remove: readonly { readonly path: string; readonly what: string }[]
  readonly keep: readonly { readonly path: string; readonly what: string }[]
}

export function uninstallPlan(at: Paths, o: { purge?: boolean } = {}): UninstallPlan {
  const remove: { path: string; what: string }[] = []
  const keep: { path: string; what: string }[] = []
  const exists = (p: string) => {
    try {
      lstatSync(p)
      return true
    } catch {
      return false
    }
  }
  if (exists(at.pluginLink)) remove.push({ path: at.pluginLink, what: "the plugin link" })
  if (exists(at.tuiDir)) remove.push({ path: at.tuiDir, what: "the TUI package (and its entry in cli.json)" })
  if (exists(at.unit)) remove.push({ path: at.unit, what: "the omacode-services unit (stopped first)" })
  const tools = join(at.data, "tools")
  const services = join(at.data, "services")
  if (o.purge) {
    if (exists(tools)) remove.push({ path: tools, what: "the creative tools omacode installed (HyperFrames, ComfyUI)" })
    if (exists(services)) remove.push({ path: services, what: "the services' decider, settings and downloaded models" })
  } else {
    if (exists(tools)) keep.push({ path: tools, what: "the creative tools (HyperFrames, ComfyUI); --purge removes them" })
    if (exists(services)) keep.push({ path: services, what: "the services' decider and downloaded models; --purge removes them" })
  }
  if (exists(at.state)) keep.push({ path: at.state, what: "journal, memory and model registry: your data, never removed here" })
  if (exists(at.config)) keep.push({ path: at.config, what: "your settings" })
  for (const p of pluginEntries(readJson(at.opencodeJson)).filter((x) => /omacode|micromanager/i.test(x))) {
    keep.push({ path: at.opencodeJson, what: `the plugin entry ${p}; opencode plugin remove takes it out` })
  }
  if (comfyMcpConfigured(readJson(at.opencodeJson))) keep.push({ path: at.opencodeJson, what: "the comfy MCP server entry; remove mcp.servers.comfy by hand if you want it gone" })
  keep.push({ path: "uv tool list", what: "comfy-cli, comfy-mcp and Manim as uv tools: uv tool uninstall <name>" })
  return { remove, keep }
}

// ---------------------------------------------------------------------------------------------------------------------

const MARK: Readonly<Record<Level, string>> = { ok: "✓", warn: "!", fail: "✗", info: "·" }

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.area.length), 4)
  return checks.map((c) => `${MARK[c.level]} ${c.area.padEnd(width)}  ${c.text}${c.fix ? `\n  ${" ".repeat(width)}  → ${c.fix}` : ""}`).join("\n")
}

export const failed = (checks: readonly Check[]): boolean => checks.some((c) => c.level === "fail")
