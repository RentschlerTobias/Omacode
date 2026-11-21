// Private data in requests to cloud models: secrets and structured personal data (e-mail, phone, IBAN, card) on by
// default; names and addresses through the local GLiNER server only when asked for, since that detector is not
// calibrated yet. "allow" lists values that are never replaced; the git author is added to it at start.
//
// This module has no dependency on the orchestrator: the guard plugin reads the same block on its own.
import { stripComments } from "./jsonc.ts"

export interface RedactSettings {
  readonly secrets: boolean
  readonly pii: boolean
  readonly names: boolean
  // A project's opt-out of the name/address detector only: secrets, paths and structured data stay redacted when it is
  // off. Name detection also needs "names" (true by default).
  readonly nameAddress: boolean
  readonly threshold: number
  readonly allow: readonly string[]
}

// Names are on by default since 2026-11-21: the tuned decider (container plan P6) finds names at precision 0.99 and
// recall 0.98 on held-out text and found no false name in 160 000 characters of this repository's docs, where the model
// before it found a third of the names and no address, which is why it was off. It costs about 0.2 s per 1 000
// characters of new text on the CPU; without the decider, names go unchecked and the journal says so.
export const DEFAULT_REDACT: RedactSettings = { secrets: true, pii: true, names: true, nameAddress: true, threshold: 0.5, allow: [] }

export function parseRedact(text: string): RedactSettings {
  const raw = (JSON.parse(stripComments(text)) as { redact?: unknown }).redact
  if (raw === undefined) return DEFAULT_REDACT
  if (raw === false) return { ...DEFAULT_REDACT, secrets: false, pii: false, names: false }
  if (raw === true) return DEFAULT_REDACT
  const shape = 'redact must be true, false or { "secrets": bool, "pii": bool, "names": bool, "nameAddress": bool, "threshold": 0..1, "allow": ["…"] }'
  if (typeof raw !== "object" || raw === null) throw new Error(shape)
  const r = raw as Record<string, unknown>
  for (const k of ["secrets", "pii", "names", "nameAddress"]) if (r[k] !== undefined && typeof r[k] !== "boolean") throw new Error(shape)
  if (r.threshold !== undefined && (typeof r.threshold !== "number" || r.threshold <= 0 || r.threshold >= 1)) throw new Error(shape)
  if (r.allow !== undefined && !(Array.isArray(r.allow) && r.allow.every((a) => typeof a === "string"))) throw new Error(shape)
  return {
    secrets: (r.secrets as boolean | undefined) ?? DEFAULT_REDACT.secrets,
    pii: (r.pii as boolean | undefined) ?? DEFAULT_REDACT.pii,
    names: (r.names as boolean | undefined) ?? DEFAULT_REDACT.names,
    nameAddress: (r.nameAddress as boolean | undefined) ?? DEFAULT_REDACT.nameAddress,
    threshold: (r.threshold as number | undefined) ?? DEFAULT_REDACT.threshold,
    allow: (r.allow as string[] | undefined) ?? [],
  }
}

// A guard-only file may hold the block at the top level instead of under "redact".
export function parseGuardRedact(text: string): RedactSettings {
  const raw = JSON.parse(stripComments(text)) as Record<string, unknown>
  if (raw.redact === undefined) return parseRedact(JSON.stringify({ redact: raw }))
  return parseRedact(text)
}
