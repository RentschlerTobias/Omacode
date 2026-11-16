// ~/.config/opencode/micromanager.jsonc: optional overrides of the routing (JSON with // comments).

import { existsSync, readFileSync } from "node:fs"

import type { DeciderMode } from "./backends.ts"
import { DEFAULT_FLOORS, type Floors } from "./decide.ts"
import { validatePolicies, type PolicySet } from "./policy.ts"
import { DEFAULT_REGISTRY, mergeRegistry, type ModelEntry } from "./registry.ts"
import { DEFAULT_ROUTING, type Routing } from "./routing.ts"
import { ROLES } from "./roles.ts"
import { DEFAULT_GRACE, DEFAULT_PICK, DEFAULT_TRIALS, MAX_TRIALS, type Grace, type Pick as TrialPick } from "./trials.ts"
import type { NotifyMode } from "./scheduler.ts"
import { DEFAULT_REDACT, parseRedact, type RedactSettings } from "@omacode/core/redact-config"
import { stripComments } from "@omacode/core/jsonc"
import { userConfigPath } from "@omacode/core/paths"

export { DEFAULT_REDACT, parseRedact, stripComments, type RedactSettings }

// The name before 2026-10-19 (jev-micromanager.jsonc) is still read while the new one does not exist.
export function configPath(): string {
  const path = userConfigPath("micromanager.jsonc")
  const old = userConfigPath("jev-micromanager.jsonc")
  return !existsSync(path) && existsSync(old) ? old : path
}

import {
  loadPicks,
  NO_PICKS,
  parsePicks,
  parseRouting,
  picksPath,
  savePicks,
  type Picks,
} from "@omacode/state/picks"
export { loadPicks, NO_PICKS, parsePicks, parseRouting, picksPath, savePicks, type Picks }

export function parseFloors(text: string): Floors {
  const raw = (JSON.parse(stripComments(text)) as { floors?: Record<string, unknown> }).floors ?? {}
  const floors: Record<string, number> = { ...DEFAULT_FLOORS }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_FLOORS)) throw new Error(`unknown floor ${JSON.stringify(key)}`)
    const max = key === "risk" ? 2 : 1
    if (typeof value !== "number" || value < 0 || value > max) throw new Error(`floors.${key} must be a number from 0 to ${max}`)
    floors[key] = value
  }
  return floors as unknown as Floors
}

// "decider.floors": whether the conservative floors in src/decide.ts apply to every node ("default", the only honest
// state until the A2b gate passes) or a node that passed the bench may use its measured pair ("calibrated"). It is not
// a mode: the mode stays "local" or "cloud", and nothing here can send a question to the cloud.
export function parseFloorsMode(text: string): "default" | "calibrated" {
  const raw = JSON.parse(stripComments(text)) as { decider?: { floors?: unknown } }
  const value = raw.decider?.floors
  if (value === undefined) return "default"
  if (value !== "default" && value !== "calibrated") throw new Error('decider.floors must be "default" or "calibrated"')
  return value
}

// "decisions": the global policy per decision key, e.g. { "N6.pipeline": "fixed:P1", "N5": "ask" } (design.md §22).
export function parseDecisions(text: string): PolicySet {
  const raw = (JSON.parse(stripComments(text)) as { decisions?: unknown }).decisions ?? {}
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("decisions must be an object")
  const errors = validatePolicies(raw as Record<string, unknown>)
  if (errors.length > 0) throw new Error(errors.join("; "))
  return raw as PolicySet
}

// "registry": models to add or change by id, e.g. [{ "id": "llamaswap/mimo", "disabled": true }] (design.md §19).
export function parseRegistry(text: string): ModelEntry[] {
  const raw = (JSON.parse(stripComments(text)) as { registry?: unknown }).registry ?? []
  if (!Array.isArray(raw) || !raw.every((e) => typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string" && (e as { id: string }).id.includes("/"))) {
    throw new Error('registry must be a list of objects with an "id" like "provider/model"')
  }
  return mergeRegistry(DEFAULT_REGISTRY, raw as Partial<ModelEntry>[])
}

// "notify": desktop notifications when a job needs the user or ends ("jobs", the default), also per task ("tasks"),
// or never ("off"). Updates in the micromanager's session come either way.
export function parseNotify(text: string): NotifyMode {
  const raw = (JSON.parse(stripComments(text)) as { notify?: unknown }).notify ?? "jobs"
  if (raw !== "jobs" && raw !== "tasks" && raw !== "off") throw new Error('notify must be "jobs", "tasks" or "off"')
  return raw
}

// "unsandboxed": what a job may do when no sandbox can run on this machine. D23: "unsandboxed is a user decision, never
// a default" — "ask" (the default) puts the job's checks and their risk score to the user in a form, and nothing starts
// without their answer; "never" keeps the fail-closed path of plan mode (a plan job runs reader-only); "allow" stores
// the grant without asking, journalled with the score. Without an answer, nothing runs.
export type UnsandboxedMode = "ask" | "never" | "allow"

export function parseUnsandboxed(text: string): UnsandboxedMode {
  const raw = (JSON.parse(stripComments(text)) as { unsandboxed?: unknown }).unsandboxed ?? "ask"
  if (raw !== "ask" && raw !== "never" && raw !== "allow") throw new Error('unsandboxed must be "ask", "never" or "allow"')
  return raw
}

// "budget": per job, { "tokens": 4000000, "requests": 800, "cost": 5 }; the defaults below, capped by hard ceilings
// so a typo cannot make a job unbounded (design.md §10.2).
export interface Budget {
  readonly tokens?: number
  readonly requests?: number
  readonly cost?: number
}

// No limits unless the config sets them (the user's choice, 2026-10-05: a job cut at a limit wastes its work).
export const DEFAULT_BUDGET: Budget = {}
const CEILINGS = { tokens: 50_000_000, requests: 5000, cost: 1000 } as const

export function parseBudget(text: string): Budget {
  const raw = (JSON.parse(stripComments(text)) as { budget?: unknown }).budget
  if (raw === undefined) return DEFAULT_BUDGET
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("budget must be an object")
  const out: Record<string, number> = { ...DEFAULT_BUDGET }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in CEILINGS)) throw new Error(`unknown budget ${JSON.stringify(key)}`)
    if (typeof value !== "number" || value <= 0) throw new Error(`budget.${key} must be a positive number`)
    out[key] = Math.min(value, CEILINGS[key as keyof typeof CEILINGS])
  }
  return out
}

// "checkTimeout": how long one check of a task may run, in seconds (default 300). A check that hangs must not hold
// the job's gate for ever, and a long build needs more than the default. The job may lower or raise it for itself
// (src/state.ts Job.checkTimeoutMs); the default stays 300 s.
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000
const CHECK_TIMEOUT_CEILING_MS = 3_600_000

export function parseCheckTimeout(text: string): number {
  const raw = (JSON.parse(stripComments(text)) as { checkTimeout?: unknown }).checkTimeout
  if (raw === undefined) return DEFAULT_CHECK_TIMEOUT_MS
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) throw new Error("checkTimeout must be a number of seconds above 0")
  return Math.min(Math.round(raw * 1000), CHECK_TIMEOUT_CEILING_MS)
}

// "parallel": tasks of one job at the same time (default 3, at most 6); 1 runs them one after another.
// "perModel": sessions of one cloud model at the same time (default 2, at most 4); a local model serves one.
export function parseParallel(text: string): { parallel: number; perModel: number } {
  const raw = JSON.parse(stripComments(text)) as { parallel?: unknown; perModel?: unknown }
  const int = (v: unknown, name: string, def: number, max: number) => {
    if (v === undefined) return def
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${name} must be a whole number from 1`)
    return Math.min(v, max)
  }
  return { parallel: int(raw.parallel, "parallel", 3, 6), perModel: int(raw.perModel, "perModel", 2, 4) }
}

// "trials": attempts a hard writer task runs as at once, each on another model (default 1: one worker, then a retry;
// set 2-4 for a trial; src/trials.ts).
export function parseTrials(text: string): number {
  const raw = (JSON.parse(stripComments(text)) as { trials?: unknown }).trials
  if (raw === undefined) return DEFAULT_TRIALS
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new Error("trials must be a whole number from 1")
  return Math.min(raw, MAX_TRIALS)
}

// "trialDeadline": minutes a trial decided by score (an attempt measured against a fitness contract, src/contract.ts)
// waits after its first passing attempt for the others; then the best of the passed ones is merged. Default 20.
export function parseTrialDeadline(text: string): number {
  const raw = (JSON.parse(stripComments(text)) as { trialDeadline?: unknown }).trialDeadline
  if (raw === undefined) return 20
  if (typeof raw !== "number" || !(raw > 0)) throw new Error("trialDeadline must be a number of minutes above 0")
  return raw
}

// "trialPick": who decides a trial, by agent ("designer") or role id ("visual"), "*" for the rest: "first", "best" or
// "user" (src/trials.ts; a contract always decides by score). Keys not named keep their default.
export function parseTrialPick(text: string): Record<string, TrialPick> {
  const raw = (JSON.parse(stripComments(text)) as { trialPick?: unknown }).trialPick
  const out: Record<string, TrialPick> = { ...DEFAULT_PICK }
  if (raw === undefined) return out
  const shape = 'trialPick must be { "<agent or *>": "first" | "best" | "user" }'
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(shape)
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== "first" && v !== "best" && v !== "user") throw new Error(shape)
    const role = k === "*" ? undefined : ROLES.find((r) => r.agent === k || r.id === k)
    if (k !== "*" && !role) throw new Error(`trialPick: unknown agent ${JSON.stringify(k)}`)
    out[role?.id ?? "*"] = v
  }
  return out
}

// "trialGrace": the grace window of a "best" trial: the others get factor x the first passing attempt's time, at least
// minMinutes and at most maxMinutes. Default 0.5, 2 and 10.
export function parseTrialGrace(text: string): Grace {
  const raw = (JSON.parse(stripComments(text)) as { trialGrace?: unknown }).trialGrace
  if (raw === undefined) return DEFAULT_GRACE
  const shape = 'trialGrace must be { "factor": 0.., "minMinutes": 0.., "maxMinutes": 0.. }'
  if (typeof raw !== "object" || raw === null) throw new Error(shape)
  const g = raw as { factor?: unknown; minMinutes?: unknown; maxMinutes?: unknown }
  for (const v of [g.factor, g.minMinutes, g.maxMinutes]) if (v !== undefined && (typeof v !== "number" || v < 0)) throw new Error(shape)
  const minutes = (v: unknown, d: number) => (v === undefined ? d : (v as number) * 60_000)
  return { factor: (g.factor as number | undefined) ?? DEFAULT_GRACE.factor, minMs: minutes(g.minMinutes, DEFAULT_GRACE.minMs), maxMs: minutes(g.maxMinutes, DEFAULT_GRACE.maxMs) }
}

// "decider": { "mode": "local" | "cloud" }. "local" is the mode from day one (D21): every decision stays on this
// machine. "cloud" may send a decision to the cloud decision client — after deterministic redaction and, without a
// local NER, a preview and confirmation (D13). There is no hybrid (D11); a missing backend is a state, not a mode.
//
// The key before A2 was "cloudOnly": true becomes mode "cloud" and false (or an absent key) becomes "local". The true
// case is reported, because an old file must not become cloud mode silently; the lines come back from loadSettings and
// plugin.setup logs each one (src/plugin.ts), where the memory migration reports too.
export function parseMode(text: string, migrations: string[] = []): DeciderMode {
  const raw = JSON.parse(stripComments(text)) as { decider?: unknown; cloudOnly?: unknown }
  if (raw.decider !== undefined && (typeof raw.decider !== "object" || raw.decider === null || Array.isArray(raw.decider))) {
    throw new Error('decider must be an object, e.g. { "mode": "local" }')
  }
  const decider = raw.decider as { mode?: unknown } | undefined
  if (decider?.mode !== undefined) {
    if (raw.cloudOnly !== undefined) throw new Error('use "decider": { "mode": … } or the old "cloudOnly", not both')
    if (decider.mode !== "local" && decider.mode !== "cloud") throw new Error('decider.mode must be "local" or "cloud"')
    return decider.mode
  }
  if (raw.cloudOnly === undefined) return "local"
  if (typeof raw.cloudOnly !== "boolean") throw new Error("cloudOnly must be true or false")
  if (!raw.cloudOnly) return "local"
  migrations.push('config: "cloudOnly": true is now "decider": { "mode": "cloud" } — "cloudOnly" was removed in A2 (D11 gave the decider two modes, and cloudOnly is not one), so this file names the mode it meant; write "mode": "local" to keep everything on this machine')
  return "cloud"
}

// "githubBacklog": the GitHub repositories ("owner/name") whose issues labelled micromanager are part of the backlog
// (src/backlog.ts, design.md §25 P7). Off for every other project: an issue is published content, so each repository is
// opted in by name. Reading them is free; an issue is only ever created after the user says so in a form.
export function parseGithubBacklog(text: string): readonly string[] {
  const raw = (JSON.parse(stripComments(text)) as { githubBacklog?: unknown }).githubBacklog ?? []
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(r))) throw new Error('githubBacklog must be a list of repositories, e.g. ["owner/name"]')
  return raw.map((r: string) => r.toLowerCase())
}

// "evolver": { "maxEvalSeconds": 600 }: the longest full measurement for which the plugin still offers the evolver
// (src/evolver.ts). Long ones are what a multi-step algorithm takes; a quick stage in the contract keeps them affordable.
export function parseEvolver(text: string): number {
  const raw = (JSON.parse(stripComments(text)) as { evolver?: { maxEvalSeconds?: unknown } }).evolver?.maxEvalSeconds
  if (raw === undefined) return 600
  if (typeof raw !== "number" || !(raw > 0)) throw new Error("evolver.maxEvalSeconds must be a number of seconds above 0")
  return raw
}

// "allowOutside": absolute paths (or path prefixes) a worker may reach even where src/decide.ts refuses, e.g.
// ["/home/u/.config/omarchy"]. Empty by default: the user's list is the only thing that lifts those rules, and it lifts
// nothing until they write it. A wrong entry here is a widened rule, so the value is checked, not cast: a list of
// non-empty strings, each of which resolves to an absolute path. `~` is left to src/decide.ts to expand, so what the
// user wrote is what they can see in the journal.
export function parseAllowOutside(text: string): readonly string[] {
  const raw = (JSON.parse(stripComments(text)) as { allowOutside?: unknown }).allowOutside ?? []
  if (!Array.isArray(raw)) throw new Error('allowOutside must be a list of absolute paths, e.g. ["/home/u/.config/omarchy"]')
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`allowOutside must be a list of absolute paths; ${JSON.stringify(entry)} is not one`)
    }
    const path = entry.trim()
    // A relative entry is a silent no-op or, worse, a guess at the cwd of whatever asked; say so instead.
    if (!path.startsWith("/") && path !== "~" && !path.startsWith("~/")) {
      throw new Error(`allowOutside entries must be absolute paths (or start with ~), got ${JSON.stringify(entry)}`)
    }
    // The entry is kept as written (src/decide.ts normalises it when it matches), so the journal shows the user their
    // own words. A repeated entry is dropped: a list that lists the same path twice says nothing a list says once.
    if (!out.includes(path)) out.push(path)
  }
  return out
}

// "sandbox": run worker commands in the sandbox (src/shell/sandbox.ts; default true). "env": names of variables worker
// commands keep beyond the allowlist ("DATABASE_URL", or "MYAPP_*"). "network": domains worker commands may reach
// beyond the package registries ("api.example.com", "*.example.com", "host:8443"). Both lists are the user's standing
// grants for every job; a single job's grants come from request_env / request_network.
export function parseSandbox(text: string): { sandbox: boolean; env: readonly string[]; network: readonly string[] } {
  const raw = JSON.parse(stripComments(text)) as { sandbox?: unknown; env?: unknown; network?: unknown }
  const sandbox = raw.sandbox ?? true
  if (typeof sandbox !== "boolean") throw new Error("sandbox must be true or false")
  const list = (value: unknown, name: string, ok: RegExp, example: string): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && ok.test(v))) throw new Error(`${name} must be a list like ${example}`)
    return [...new Set(value as string[])]
  }
  return {
    sandbox,
    env: list(raw.env, "env", /^[A-Za-z_][A-Za-z0-9_]*\*?$/, '["DATABASE_URL", "MYAPP_*"]'),
    network: list(raw.network, "network", /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/, '["api.example.com", "*.example.com"]'),
  }
}

// The memory (src/context/): on by default; "embedding" names the local service install.sh --embedding sets up, false
// for keyword search only. The model id is recorded with every vector, so a new size re-embeds rather than mixes.
export interface MemorySettings {
  readonly enabled: boolean
  readonly embedding: { readonly url: string; readonly model: string } | false
}

export const DEFAULT_MEMORY: MemorySettings = { enabled: true, embedding: { url: "http://127.0.0.1:8093", model: "qwen3-embedding-4b" } }

export function parseMemory(text: string): MemorySettings {
  const raw = (JSON.parse(stripComments(text)) as { memory?: unknown }).memory
  if (raw === undefined) return DEFAULT_MEMORY
  if (typeof raw === "boolean") return { ...DEFAULT_MEMORY, enabled: raw }
  if (typeof raw !== "object" || raw === null) throw new Error('memory must be true, false or { "embedding": { "url": …, "model": … } | false }')
  const m = raw as { enabled?: unknown; embedding?: unknown }
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") throw new Error("memory.enabled must be true or false")
  let embedding: MemorySettings["embedding"] = DEFAULT_MEMORY.embedding
  if (m.embedding === false) embedding = false
  else if (m.embedding !== undefined) {
    const e = m.embedding as { url?: unknown; model?: unknown }
    if (typeof e !== "object" || e === null || (e.url !== undefined && typeof e.url !== "string") || (e.model !== undefined && typeof e.model !== "string")) throw new Error('memory.embedding must be { "url": "http://…", "model": "qwen3-embedding-4b" } or false')
    embedding = { url: String(e.url ?? (DEFAULT_MEMORY.embedding as { url: string }).url), model: String(e.model ?? (DEFAULT_MEMORY.embedding as { model: string }).model) }
  }
  return { enabled: m.enabled ?? true, embedding }
}

// With mode "cloud", local models stay in the registry (they show up in the journal's ranking) but are never routed to.
export function cloudRegistry(registry: readonly ModelEntry[]): ModelEntry[] {
  return registry.map((m) => (m.location === "local" ? { ...m, disabled: true } : m))
}

export interface Settings {
  readonly mode: DeciderMode // the decider's mode: "local" (D21) or "cloud", never a hybrid
  // One line per config key that was migrated to its new name or shape (A2, the "cloudOnly" -> "decider.mode" move);
  // plugin.setup logs them as warnings, so an old config cannot change behaviour without saying so.
  readonly migrations: readonly string[]
  readonly parallel: number
  readonly perModel: number
  readonly trials: number
  readonly trialDeadline: number // minutes
  readonly budget: Budget
  // How long one check may run, in milliseconds (default 300 s). A job may override it (src/state.ts).
  readonly checkTimeoutMs: number
  readonly notify: NotifyMode
  // What a job may do when no sandbox can run here ("unsandboxed", D23): ask the user, never, or allow.
  readonly unsandboxed: UnsandboxedMode
  readonly routing: Routing
  readonly floors: Floors
  readonly deciderFloors: "default" | "calibrated" // the A2b gate: may a passing node use measured floors?
  readonly decisions: PolicySet
  readonly registry: readonly ModelEntry[]
  readonly allowOutside: readonly string[]
  readonly githubBacklog: readonly string[]
  readonly evolverMaxEvalSeconds: number
  readonly sandbox: boolean
  readonly env: readonly string[]
  readonly network: readonly string[]
  readonly memory: MemorySettings
  readonly redact: RedactSettings
  readonly trialPick: Readonly<Record<string, TrialPick>>
  readonly trialGrace: Grace
}

// The settings a config file that is missing or broken falls back to. One place, so the two returns below cannot drift
// apart and a setting added here is never left out of the error path.
const DEFAULTS: Omit<Settings, "registry"> = {
  mode: "local",
  migrations: [],
  parallel: 3,
  perModel: 2,
  trials: DEFAULT_TRIALS,
  trialDeadline: 20,
  budget: DEFAULT_BUDGET,
  checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
  notify: "jobs",
  unsandboxed: "ask",
  routing: DEFAULT_ROUTING,
  floors: DEFAULT_FLOORS,
  deciderFloors: "default",
  decisions: {},
  allowOutside: [],
  githubBacklog: [],
  evolverMaxEvalSeconds: 600,
  sandbox: true,
  env: [],
  network: [],
  memory: DEFAULT_MEMORY,
  redact: DEFAULT_REDACT,
  trialPick: DEFAULT_PICK,
  trialGrace: DEFAULT_GRACE,
}

export function loadSettings(path = configPath()): Settings & { error?: string } {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { ...DEFAULTS, registry: DEFAULT_REGISTRY } // no file: the defaults
  }
  try {
    const migrations: string[] = []
    return { ...DEFAULTS, mode: parseMode(text, migrations), ...parseParallel(text), trials: parseTrials(text), trialDeadline: parseTrialDeadline(text), budget: parseBudget(text), checkTimeoutMs: parseCheckTimeout(text), notify: parseNotify(text), unsandboxed: parseUnsandboxed(text), routing: parseRouting(text), floors: parseFloors(text), deciderFloors: parseFloorsMode(text), decisions: parseDecisions(text), registry: parseRegistry(text), allowOutside: parseAllowOutside(text), githubBacklog: parseGithubBacklog(text), evolverMaxEvalSeconds: parseEvolver(text), ...parseSandbox(text), memory: parseMemory(text), redact: parseRedact(text), trialPick: parseTrialPick(text), trialGrace: parseTrialGrace(text), migrations }
  } catch (err) {
    return { ...DEFAULTS, registry: DEFAULT_REGISTRY, error: `${path}: ${String(err)}` }
  }
}
