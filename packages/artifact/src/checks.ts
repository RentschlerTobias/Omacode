// The checks registry (B1-T2): what can be said about an artifact, who is allowed to say it, and what a run of those
// sayings means. A spec (spec.ts) describes the artifact; a check is the promise that someone looked, and a result is
// the record that they did. This file owns those three words and their arithmetic, not the programs that produce the
// results — an adapter (B1-T4) supplies a program, the host runner (B1-T5) runs it, and the quality gate (B1-T7)
// decides what a skip is worth. Keeping the semantics here means those three cannot each invent a different meaning for
// "failed".
//
// The levels are not a severity scale but a statement of who can make the call:
//
//   L0  the contract itself — the spec parses against this package;
//   L1  mechanical — files exist, counts add up, links resolve, a program exits zero;
//   L2  visual — a snapshot compared, a VLM asked about a rendered page;
//   L3  human — a person looked at the thing and said yes.
//
// They are kept apart because a program cannot give the last one, and because a parse failure cannot be delegated to a
// program that the very spec being checked might have broken.
//
// Nothing here touches the filesystem, the clock or a process: a check is a value, a result is a value, and a plan is a
// function of the two. That is what lets the gate be tested without rendering a slide.

import { ARTIFACT_KINDS, type ArtifactKind } from "./spec.ts"

export const CHECK_LEVELS = ["L0", "L1", "L2", "L3"] as const
export type CheckLevel = (typeof CHECK_LEVELS)[number]

// A check as the registry declares it, before anything has run. `run` says who may produce the result, and it has to
// agree with the level (assertRegistry enforces that): a program cannot declare a contract check, and only a person
// can give L3. `required` defaults to true — an optional check is one a job may legitimately not be able to run, and
// the caller (B1-T7) decides whether that is acceptable.
export interface CheckDef {
  readonly id: string
  readonly level: CheckLevel
  readonly kind: ArtifactKind
  readonly title: string
  readonly run: "spec" | "argv" | "human"
  readonly required?: boolean
}

// A check that did not run. The code is -1 because no program can exit with a negative code: "did not run" cannot be
// mistaken for "ran and failed" by a reader that only looks at the number.
export const SKIPPED_CODE = -1

// What one check said. The exit code carries the verdict and the status has to agree with it: a "passed" with a
// non-zero code is a failed program that was talked up, and a "failed" with zero is a check that wanted to fail without
// saying why. `reason` is mandatory for a skip — "no browser here" is a fact about the job, and a silent skip is
// indistinguishable from a check nobody wrote.
export interface CheckResult {
  readonly id: string
  readonly level: CheckLevel
  readonly status: "passed" | "failed" | "skipped"
  readonly code: number
  readonly reason?: string
  readonly output?: string
}

// What a level may be produced by. L0 is this package's own contract parse, so a registry entry that calls itself L0
// while running argv is a program grading its own homework. L3 is the opposite side of the same rule: a person is the
// only one who can say that a person looked.
const RUN_FOR_LEVEL: Record<CheckLevel, CheckDef["run"]> = {
  L0: "spec",
  L1: "argv",
  L2: "argv",
  L3: "human",
}

// The kind an id promises, or undefined when it promises none. An id carries its kind so a result can be read without
// its definition beside it: "deck.overflow" is a deck check even in a log that no longer has the registry.
function idPrefix(id: string): string | undefined {
  const dot = id.indexOf(".")
  return dot > 0 ? id.slice(0, dot) : undefined
}

const isKind = (value: string): value is ArtifactKind => (ARTIFACT_KINDS as readonly string[]).includes(value)

// Refuse a registry that is internally inconsistent. Everything here is a mistake in code, not in data, so it throws
// instead of returning errors: a registry that ships is one that passed this function, and a caller never has to cope
// with half a meaning. The message names the offender, because the reader is the person editing the registry.
export function assertRegistry(defs: readonly CheckDef[]): void {
  const seen = new Set<string>()
  for (const def of defs) {
    if (seen.has(def.id)) throw new Error(`duplicate check id "${def.id}"`)
    seen.add(def.id)

    const prefix = idPrefix(def.id)
    if (prefix === undefined || !isKind(prefix)) {
      throw new Error(
        `check "${def.id}": an id must start with a known artifact kind and a dot (${ARTIFACT_KINDS.join(", ")})`,
      )
    }
    if (prefix !== def.kind) {
      throw new Error(`check "${def.id}": the id says "${prefix}" but the kind is "${def.kind}"`)
    }

    const run = RUN_FOR_LEVEL[def.level]
    if (run === undefined) throw new Error(`check "${def.id}": unknown level ${JSON.stringify(def.level)}`)
    if (def.run !== run) throw new Error(`check "${def.id}": ${def.level} must run as "${run}", got "${def.run}"`)
  }
}

const levelRank = (level: CheckLevel): number => {
  const rank = CHECK_LEVELS.indexOf(level)
  return rank === -1 ? CHECK_LEVELS.length : rank
}

// The one order the board reads in: L0 first, then by id. Applied to results and to defs, so a plan and a coverage
// report of the same registry line up whichever order the caller handed them over.
const byLevelThenId = (a: { readonly id: string; readonly level: CheckLevel }, b: { readonly id: string; readonly level: CheckLevel }): number => {
  const byLevel = levelRank(a.level) - levelRank(b.level)
  if (byLevel !== 0) return byLevel
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

// Why a result cannot be believed, or undefined when it can. The check is on the combination, not the word: any one of
// these three fields can be right while the result as a whole contradicts itself.
function resultProblem(result: CheckResult): string | undefined {
  switch (result.status) {
    case "passed":
      return result.code === 0 ? undefined : `passed with exit code ${result.code}, expected 0`
    case "failed":
      return result.code !== 0 ? undefined : "failed with exit code 0, expected non-zero"
    case "skipped":
      if (result.code !== SKIPPED_CODE) return `skipped with exit code ${result.code}, expected ${SKIPPED_CODE}`
      return result.reason?.trim() ? undefined : "skipped without a reason"
    default:
      return `unknown status ${shown(result.status)}`
  }
}

export interface Coverage {
  readonly ok: boolean
  readonly results: readonly CheckResult[]
  readonly missing: readonly string[]
  readonly invalid: readonly string[]
  readonly skipped: readonly CheckResult[]
  readonly failed: readonly CheckResult[]
}

// What the results so far add up to. `ok` is deliberately not the whole answer: a skipped check is not a pass, it is
// listed in `skipped` and the caller decides whether that skip is acceptable. "No browser here" and "the slide
// overflows" both leave the artifact unchecked in some way, but only one of them is the artifact's fault — this
// function cannot know which, so it does not pretend either was checked.
export function evaluate(defs: readonly CheckDef[], results: readonly CheckResult[]): Coverage {
  const defById = new Map(defs.map((def) => [def.id, def]))
  const invalid: string[] = []
  const present = new Set<string>()
  const failed: CheckResult[] = []
  const skipped: CheckResult[] = []

  for (const result of results) {
    const def = defById.get(result.id)
    if (def === undefined) {
      invalid.push(`unknown check "${result.id}"`)
      continue
    }
    // A def that has any result is not missing, even when that result is refused: it is invalid, and that is a
    // different complaint from "nothing ran".
    present.add(result.id)
    const problem = resultProblem(result)
    if (problem !== undefined) {
      invalid.push(`${result.id}: ${problem}`)
      continue
    }
    if (def.level !== result.level) {
      invalid.push(`${result.id}: level ${result.level} does not match its definition (${def.level})`)
      continue
    }
    if (result.status === "failed") failed.push(result)
    else if (result.status === "skipped") skipped.push(result)
  }

  const missing = defs
    .filter((def) => def.required !== false && !present.has(def.id))
    .sort(byLevelThenId)
    .map((def) => def.id)

  return {
    ok: invalid.length === 0 && missing.length === 0 && failed.length === 0,
    results: [...results].sort(byLevelThenId),
    missing,
    invalid,
    skipped,
    failed,
  }
}

// What to run next, and what will not run at all. A level starts only once the previous one is finished without a
// failure, so a broken contract is caught before anything expensive renders. Inside a level a failure does not cut the
// level short: its other checks still run, because one bad slide should be reported beside the rest, not instead of
// them. Only the levels after a failure are skipped, and the reason names the checks that caused it, so the board can
// say why they did not run without a second lookup.
export function checkPlan(
  defs: readonly CheckDef[],
  results: readonly CheckResult[],
): { readonly next: readonly CheckDef[]; readonly skip: readonly { readonly id: string; readonly reason: string }[] } {
  const defById = new Map(defs.map((def) => [def.id, def]))
  const done = new Set(results.map((result) => result.id))
  const failedAt = new Map<CheckLevel, string[]>()

  for (const result of results) {
    if (result.status !== "failed") continue
    const def = defById.get(result.id)
    if (def === undefined) continue
    const ids = failedAt.get(def.level) ?? []
    if (!ids.includes(def.id)) ids.push(def.id)
    failedAt.set(def.level, ids)
  }

  const next: CheckDef[] = []
  const skip: { id: string; reason: string }[] = []
  let blocker: { readonly level: CheckLevel; readonly ids: readonly string[] } | undefined

  for (const level of CHECK_LEVELS) {
    const atLevel = defs.filter((def) => def.level === level).sort(byLevelThenId)
    const remaining = atLevel.filter((def) => !done.has(def.id))

    if (blocker !== undefined) {
      const reason = `not run: ${blocker.level} failed (${blocker.ids.join(", ")})`
      for (const def of remaining) skip.push({ id: def.id, reason })
      continue
    }

    const failedIds = failedAt.get(level) ?? []
    if (failedIds.length > 0) {
      next.push(...remaining)
      blocker = { level, ids: [...failedIds].sort() }
      continue
    }

    if (remaining.length > 0) {
      next.push(...remaining)
      // Strictly level by level: L2 does not start while L1 is unfinished, even when nothing has failed yet. "Not
      // finished" is a reason to wait, not a reason to skip.
      break
    }
  }

  return { next, skip }
}

// The registry this package ships with: one contract check per artifact kind, and nothing else. B1-T2 owns exactly
// these four; the mechanical, visual and human checks arrive with the adapters that can make them (B3-T4, B5-T5,
// B4-T3), and they must be added here rather than invented by a spec — a spec selects ids (spec.ts `checks`), it does
// not define them.
export const CONTRACT_CHECKS: readonly CheckDef[] = ARTIFACT_KINDS.map(
  (kind): CheckDef => ({
    id: `${kind}.contract`,
    level: "L0",
    kind,
    title: `the ${kind} spec parses`,
    run: "spec",
    required: true,
  }),
)

// The checks of one artifact type, in level order, so an adapter can be handed its own slice of the registry without
// filtering the rest itself.
export function checksFor(defs: readonly CheckDef[], kind: ArtifactKind): readonly CheckDef[] {
  return defs.filter((def) => def.kind === kind).sort(byLevelThenId)
}
