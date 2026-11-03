import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stripComments } from "@omacode/core/jsonc"
import { DEFAULT_REDACT, parseRedact, type RedactSettings } from "@omacode/core/redact-config"

function configDir(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}

function parseOne(path: string, requireRedact: boolean): RedactSettings | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(stripComments(readFileSync(path, "utf8"))) as { redact?: unknown }
    if (requireRedact && raw.redact === undefined) return undefined
    return parseRedact(JSON.stringify({ redact: raw.redact ?? raw }))
  } catch {
    return DEFAULT_REDACT
  }
}

// A guard must not depend on the orchestrator: its own file wins, the micromanager file is only a migration fallback.
export function guardConfigPath(projectDir?: string): string | undefined {
  const dirs = projectDir ? [join(projectDir, ".opencode")] : []
  dirs.push(join(configDir(), "opencode"))
  for (const dir of dirs) {
    for (const name of ["guard.jsonc", "micromanager.jsonc"]) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

export function loadGuardSettings(projectDir?: string): RedactSettings {
  const dirs = projectDir ? [join(projectDir, ".opencode")] : []
  dirs.push(join(configDir(), "opencode"))
  for (const dir of dirs) {
    const guard = parseOne(join(dir, "guard.jsonc"), false)
    if (guard) return guard
    const fallback = parseOne(join(dir, "micromanager.jsonc"), true)
    if (fallback) return fallback
  }
  return DEFAULT_REDACT
}
