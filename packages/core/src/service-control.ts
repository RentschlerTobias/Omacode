// Switching the supervisor's services from outside it: the TUI's /services menu and `services mode` in the CLI.
// The supervisor (./supervisor.ts) polls its control file for a mode and a device per service and the idle time, and writes what
// each service is doing to <run>/status.json; this module only reads the one and merges into the other, so neither
// side needs a socket or the token.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { runDir } from "./services.ts"
import type { Device, Mode, State } from "./supervisor.ts"

export const MODES: readonly Mode[] = ["on", "auto", "off"]
export const IDLE_CHOICES: readonly number[] = [5, 10, 30, 60]

export interface ServiceView {
  readonly name: string
  // What was asked (control.json), else what the supervisor last reported.
  readonly mode: Mode
  readonly state: State | "unknown"
  readonly url?: string
  readonly detail?: string
  // Where it runs (asked, else reported) and where it could; no list: the service has no choice.
  readonly device?: string
  readonly devices?: readonly Device[]
}

export interface ServicesView {
  readonly running: boolean
  readonly updated?: string
  readonly idleMinutes?: number
  readonly services: readonly ServiceView[]
}

type Json = Record<string, unknown>

function readJson(path: string): Json | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : undefined
  } catch {
    return undefined
  }
}

const isMode = (x: unknown): x is Mode => MODES.includes(x as Mode)

// No status file: no supervisor has run since the last login (the run directory is a tmpfs).
export function servicesView(env: NodeJS.ProcessEnv = process.env): ServicesView {
  const dir = runDir(env)
  const status = readJson(join(dir, "status.json"))
  const control = readJson(controlFile(env, status)) ?? {}
  const raw = (status?.services ?? {}) as Record<string, Json>
  const asked = (control.devices && typeof control.devices === "object" ? control.devices : {}) as Record<string, unknown>
  const services = Object.entries(raw).map(([name, s]): ServiceView => ({
    name,
    mode: isMode(control[name]) ? control[name] : isMode(s.mode) ? s.mode : "auto",
    state: typeof s.state === "string" ? (s.state as State) : "unknown",
    ...(typeof s.url === "string" ? { url: s.url } : {}),
    ...(typeof s.detail === "string" ? { detail: s.detail } : {}),
    ...(typeof asked[name] === "string" ? { device: asked[name] as string } : typeof s.device === "string" ? { device: s.device } : {}),
    ...(Array.isArray(s.devices) ? { devices: s.devices as Device[] } : {}),
  }))
  const minutes = Number(control.idleMinutes ?? status?.idleMinutes)
  return {
    running: Boolean(status),
    ...(typeof status?.updated === "string" ? { updated: status.updated } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { idleMinutes: minutes } : {}),
    services,
  }
}

// The supervisor's control file, as its status file names it; <run>/control.json for one that does not say.
export function controlFile(env: NodeJS.ProcessEnv = process.env, status = readJson(join(runDir(env), "status.json"))): string {
  return typeof status?.control === "string" && status.control ? status.control : join(runDir(env), "control.json")
}

function writeControl(change: Json, env: NodeJS.ProcessEnv): void {
  const path = controlFile(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next = { ...(readJson(path) ?? {}), ...change }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, path)
}

export function setServiceMode(name: string, mode: Mode, env: NodeJS.ProcessEnv = process.env): void {
  if (!isMode(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`)
  writeControl({ [name]: mode }, env)
}

export function setServiceDevice(name: string, device: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!device.trim()) throw new Error("no device named")
  const devices = readJson(controlFile(env))?.devices
  writeControl({ devices: { ...(devices && typeof devices === "object" ? devices : {}), [name]: device } }, env)
}

// The device's name for a menu line: "NVIDIA GeForce RTX 4060 Laptop GPU · 8 GB", or the id when it is not listed.
export function deviceName(s: ServiceView, id = s.device): string | undefined {
  return id ? (s.devices?.find((d) => d.id === id)?.name ?? id) : undefined
}

export function setIdleMinutes(minutes: number, env: NodeJS.ProcessEnv = process.env): void {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("idle minutes must be a positive number")
  writeControl({ idleMinutes: minutes }, env)
}

// One line per service for a menu or the CLI: "auto · running", "off", "on · starting · loading weights".
export function serviceLine(s: ServiceView): string {
  if (s.mode === "off") return "off"
  const on = s.devices && s.device ? `on ${s.device === "cpu" ? "CPU" : s.device}` : undefined
  return [s.mode, s.state === "unknown" ? undefined : s.state, on, s.detail].filter(Boolean).join(" · ")
}

export const MODE_HELP: Readonly<Record<Mode, string>> = {
  on: "start now and keep running",
  auto: "start on demand, stop after the idle time",
  off: "stop; the plugin falls back to rules and keywords",
}
