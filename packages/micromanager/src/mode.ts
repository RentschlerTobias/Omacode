// The micromanager's mode: one agent, two modes. It used to be a second primary agent, "Micromanager (plan)", which
// made the state a third thing the user had to pick and remember. The state belongs to the session instead.
//
// Plan is the default, so a new session plans and never starts work on its own. Leaving plan mode takes the user's own
// yes: `askToLeave` records that the question was put, `noteUserSpoke` records that they answered, and only a turn that
// came after the question unlocks the mode. The agent cannot unlock itself, which is what makes the mode real.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { modesPath } from "@omacode/core/paths"

export type Mode = "plan" | "build"

export const DEFAULT_MODE: Mode = "plan"

// The mode per session, the sessions the user was asked about, and when the user last spoke in each.
const modes = new Map<string, Mode>()
const asked = new Map<string, number>()
const spoke = new Map<string, number>()

const CAP = 500

function file(): string {
  return modesPath()
}

export function loadModes(): void {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>
    for (const [sessionID, mode] of Object.entries(raw)) if (mode === "plan" || mode === "build") modes.set(sessionID, mode)
  } catch {
    // No file yet, or one we cannot read: every session starts from the default, which is the safe direction.
  }
}

function save(): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const entries = [...modes].slice(-CAP)
    writeFileSync(file(), JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 })
  } catch {
    // The mode still holds in memory; a restart falls back to the default rather than to a wrong mode.
  }
}

export function modeOf(sessionID?: string): Mode {
  if (!sessionID) return DEFAULT_MODE
  return modes.get(sessionID) ?? DEFAULT_MODE
}

export function setMode(sessionID: string, mode: Mode): void {
  modes.delete(sessionID)
  modes.set(sessionID, mode) // re-insert, so the cap drops the least recently used
  save()
}

// The user's own turn: the only thing that can unlock leaving plan mode. A counter, not a clock: two events in the same
// millisecond must still order (the question, then the answer).
let tick = 0
export function noteUserSpoke(sessionID?: string): void {
  if (sessionID) spoke.set(sessionID, ++tick)
}

export function askToLeave(sessionID: string): void {
  asked.set(sessionID, ++tick)
}

export function canLeave(sessionID: string): boolean {
  const when = asked.get(sessionID)
  if (when === undefined) return false
  return (spoke.get(sessionID) ?? 0) > when
}

export function clearAsk(sessionID: string): void {
  asked.delete(sessionID)
}

// Tests set the same session up repeatedly.
export function forgetModes(): void {
  modes.clear()
  asked.clear()
  spoke.clear()
}
