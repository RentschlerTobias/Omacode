// One artifact, built from its spec file in one call: the spec is read and checked, the adapter for its kind prepares
// the project, renders it, snapshots it and runs its checks through the host runner, and the report says what came out
// and what passed (C2-T7; the plugin's make_artifact tool is the caller). The job directory is the spec file's own
// directory: every path a spec names is relative to it, and the runner keeps every program inside it.
//
// A step that throws ends the build there; the report names the step and the reason, so the agent fixes the spec or the
// content rather than guessing. A skipped check is reported as skipped, never as passed.

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import type { Adapter, AdapterContext, HostRunner } from "./adapter.ts"
import { evaluate, type CheckDef, type CheckResult, type Coverage } from "./checks.ts"
import { hostRunnerFor } from "./runner.ts"
import { ARTIFACT_KINDS, parseSpec, type ArtifactKind, type Spec } from "./spec.ts"
import { DECK_CHECKS } from "./adapters/deck-checks.ts"
import { deckAdapter } from "./adapters/deck.ts"
import { IMAGE_CHECKS, imageAdapter, type ImageAdapterOptions } from "./adapters/image.ts"
import { VIDEO_CHECKS, videoAdapter } from "./adapters/video.ts"
import { WEB_CHECKS } from "./adapters/web-checks.ts"
import { webAdapter } from "./adapters/web.ts"

export const SPEC_FILES: Readonly<Record<ArtifactKind, string>> = { deck: "deck.json", video: "video.json", site: "site.json", images: "images.json" }

const CHECK_SETS: Readonly<Record<ArtifactKind, readonly CheckDef[]>> = { deck: DECK_CHECKS, video: VIDEO_CHECKS, site: WEB_CHECKS, images: IMAGE_CHECKS }

export interface BuildOptions {
  readonly images?: ImageAdapterOptions
  // Tests hand in their own adapter or runner; the plugin uses the kind's adapter and a runner made for it.
  readonly adapter?: Adapter
  readonly runner?: HostRunner
  readonly signal?: AbortSignal
  // After a build whose checks all passed: start the adapter's presenter (a deck's `hyperframes present`) and say where.
  readonly present?: boolean
}

export type BuildStep = "spec" | "prepare" | "render" | "snapshot" | "check"

export interface BuildReport {
  readonly kind?: ArtifactKind
  readonly jobDir: string
  readonly ok: boolean
  // where it stopped, when a step threw or the spec did not parse
  readonly failed?: { readonly step: BuildStep; readonly reason: string }
  readonly notes: readonly string[]
  readonly outputs: readonly string[]
  readonly shots: readonly { readonly path: string; readonly label: string }[]
  readonly coverage?: Coverage
  readonly log: readonly string[]
  // The presenter, when one was asked for and started: its address, and how to stop it (it holds the runner).
  readonly presented?: { readonly url: string; readonly stop: () => void }
  readonly presentFailed?: string
}

export function adapterFor(kind: ArtifactKind, options: BuildOptions = {}): Adapter {
  if (kind === "deck") return deckAdapter() as unknown as Adapter
  if (kind === "video") return videoAdapter() as unknown as Adapter
  if (kind === "site") return webAdapter() as unknown as Adapter
  return imageAdapter(options.images) as unknown as Adapter
}

export async function buildArtifact(specPath: string, options: BuildOptions = {}): Promise<BuildReport> {
  const jobDir = dirname(resolve(specPath))
  const log: string[] = []
  const stop = (step: BuildStep, reason: string, rest: Partial<BuildReport> = {}): BuildReport => ({ jobDir, ok: false, failed: { step, reason }, notes: [], outputs: [], shots: [], log, ...rest })

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(specPath, "utf8"))
  } catch (err) {
    return stop("spec", `${specPath} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const kind = (raw as { kind?: unknown } | null)?.kind
  if (typeof kind !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    return stop("spec", `the spec's kind must be one of ${ARTIFACT_KINDS.join(", ")}, got ${JSON.stringify(kind)}`)
  }
  const parsed = parseSpec(kind as ArtifactKind, raw)
  if (!parsed.spec) return stop("spec", parsed.errors.join("; "), { kind: kind as ArtifactKind })
  const spec: Spec = parsed.spec

  const adapter = options.adapter ?? adapterFor(spec.kind, options)
  let runner: HostRunner
  try {
    runner = options.runner ?? (await hostRunnerFor(adapter, { jobDir }))
  } catch (err) {
    return stop("prepare", `no runner for ${adapter.name}: ${err instanceof Error ? err.message : String(err)}`, { kind: spec.kind })
  }
  const ctx: AdapterContext = { jobDir, specPath: resolve(specPath), run: runner, log: (line) => log.push(line), ...(options.signal ? { signal: options.signal } : {}) }
  let step: BuildStep = "prepare"
  let notes: readonly string[] = []
  let outputs: readonly string[] = []
  let shots: BuildReport["shots"] = []
  try {
    notes = (await adapter.prepare(spec, ctx)).notes ?? []
    step = "render"
    outputs = (await adapter.render(ctx)).outputs
    step = "snapshot"
    shots = (await adapter.snapshot(ctx)).shots
    step = "check"
    const defs = CHECK_SETS[spec.kind].filter((def) => def.run === "argv")
    const results: readonly CheckResult[] = await adapter.check(ctx, defs)
    const coverage = evaluate(defs, results)
    const report: BuildReport = { kind: spec.kind, jobDir, ok: coverage.ok, notes, outputs, shots, coverage, log }
    if (!options.present || !coverage.ok || !adapter.openEditor) return report
    try {
      await adapter.openEditor(ctx)
      const port = log.map((line) => /listening on port (\d+)/.exec(line)?.[1]).filter(Boolean).at(-1)
      if (!port) return { ...report, presentFailed: "the presenter started but named no port" }
      return { ...report, presented: { url: `http://127.0.0.1:${port}/`, stop: () => runner.cancel() } }
    } catch (err) {
      return { ...report, presentFailed: err instanceof Error ? err.message : String(err) }
    }
  } catch (err) {
    return stop(step, err instanceof Error ? err.message : String(err), { kind: spec.kind, notes, outputs, shots })
  }
}

// The report as the agent reads it: the verdict first, then what failed with its reason, what was skipped and why,
// and the files, so the next step is obvious.
export function formatBuild(report: BuildReport): string {
  const lines: string[] = []
  const what = report.kind ?? "artifact"
  if (report.failed) {
    lines.push(`${what}: stopped at ${report.failed.step}: ${report.failed.reason}`)
  } else {
    const c = report.coverage!
    lines.push(`${what}: ${report.ok ? "built, every check passed" : "built, but checks failed"} (${c.results.length - c.failed.length - c.skipped.length} passed, ${c.failed.length} failed, ${c.skipped.length} skipped)`)
    for (const f of c.failed) lines.push(`  FAILED ${f.id}: ${f.reason ?? f.output ?? ""}`.trimEnd())
    for (const m of c.missing) lines.push(`  MISSING ${m}: the adapter gave no result`)
    for (const i of c.invalid) lines.push(`  INVALID ${i}`)
    for (const s of c.skipped) lines.push(`  skipped ${s.id}: ${s.reason ?? ""}`.trimEnd())
  }
  for (const n of report.notes) lines.push(`note: ${n}`)
  if (report.outputs.length) lines.push(`files in ${report.jobDir}: ${report.outputs.join(", ")}`)
  if (report.shots.length) lines.push(`snapshots: ${report.shots.map((s) => `${s.label} (${s.path})`).join(", ")}`)
  if (report.presented) lines.push(`presenting at ${report.presented.url}`)
  if (report.presentFailed) lines.push(`could not present: ${report.presentFailed}`)
  if (report.failed || !report.ok) lines.push("Fix the spec or its content and build again; do not weaken a check.")
  if (report.log.length) lines.push("", "log (last lines):", ...report.log.slice(-12))
  return lines.join("\n")
}
