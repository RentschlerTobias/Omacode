// ~/.config/opencode/omacode-models.json (or its old name): the models the user picked per role in the TUI.
// The orchestrator reads it at each delegation; the TUI reads and writes it.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { stripComments } from "@omacode/core/jsonc"
import { DEFAULT_ROUTING, type Routing } from "./routing.ts"
import { roleById, type RoleId } from "./roles.ts"
import { configFilePath, picksFilePath } from "@omacode/core/paths"

export interface Picks {
  readonly models: Partial<Record<RoleId, readonly string[]>>
  readonly vision?: string
}

export const NO_PICKS: Picks = { models: {} }

function configPath(): string {
  return configFilePath()
}

export function picksPath(): string {
  return picksFilePath()
}

export function parseModels(raw: Record<string, unknown> | undefined): Partial<Record<RoleId, readonly string[]>> {
  const models: Partial<Record<RoleId, readonly string[]>> = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const role = roleById(id)
    if (!role) throw new Error(`unknown role ${JSON.stringify(id)} in models`)
    if (!Array.isArray(value) || value.length === 0 || !value.every((m) => typeof m === "string" && m.includes("/"))) {
      throw new Error(`models.${id} must be a non-empty list of "provider/model" strings`)
    }
    models[role.id] = value
  }
  return models
}

export function parseRouting(text: string): Routing {
  const raw = JSON.parse(stripComments(text)) as { models?: Record<string, unknown>; vision?: unknown }
  const vision = typeof raw.vision === "string" && raw.vision.includes("/") ? raw.vision : DEFAULT_ROUTING.vision
  return { models: parseModels(raw.models), vision }
}

export function parsePicks(text: string): Picks {
  const raw = JSON.parse(text) as { models?: Record<string, unknown>; vision?: unknown }
  if (raw.vision !== undefined && (typeof raw.vision !== "string" || !raw.vision.includes("/"))) throw new Error('vision must be a "provider/model" string')
  return { models: parseModels(raw.models), ...(typeof raw.vision === "string" ? { vision: raw.vision } : {}) }
}

let cachedPicks: { path: string; stamp: string; picks: Picks } | undefined

export function loadPicks(path = picksPath()): Picks {
  let stamp: string
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return NO_PICKS
  }
  if (cachedPicks?.path === path && cachedPicks.stamp === stamp) return cachedPicks.picks
  let picks: Picks
  try {
    picks = parsePicks(readFileSync(path, "utf8"))
  } catch {
    picks = NO_PICKS
  }
  cachedPicks = { path, stamp, picks }
  return picks
}

export function savePicks(picks: Picks, path = picksPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(picks, null, 2)}\n`)
  renameSync(tmp, path)
}

// Read the routing overrides from omacode.jsonc without loading the rest of the settings.
export function loadRouting(path = configPath()): Routing {
  try {
    return parseRouting(readFileSync(path, "utf8"))
  } catch {
    return DEFAULT_ROUTING
  }
}
