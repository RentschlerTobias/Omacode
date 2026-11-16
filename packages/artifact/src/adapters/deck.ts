// The deck adapter's room in the package (B3), and the entry point a caller imports: the one fact the adapter cannot
// invent — whether the engine that would make a deck is here at all — the tool row the deck carries, and the adapter
// object itself.
//
// HyperFrames is a precondition and not a dependency on another job, so this file owns the check and the licence row
// (B3-T0). Both now live in `hyperframes.ts` (B2-T1), because the video adapter asks the same questions; they are
// re-exported below so a caller still imports a deck from one place. The three concerns the adapter grew beside it live
// in their own modules: `deck-project.ts` writes the slideshow project and scans its assets (B3-T2), `deck-run.ts` asks
// the engine to check, snapshot and present it (B3-T3), and `deck-checks.ts` turns the engine's report into check
// results (B3-T4).
//
// Nothing here looks for the program itself. It asks the host runner (B1-T5), the one place a program may be started,
// and the runner answers with a result rather than an exception: missing, refused and crashed all arrive the same way,
// and the sentence a user reads is built from that answer. There is no `child_process` import and no shell, because a
// check that could start a program on its own would be a second door past the allowlist the runner exists to keep.

import { relative, resolve } from "node:path"

import type { Adapter, HostRunner } from "../adapter.ts"
import { insidePath } from "../paths.ts"
import type { DeckSpec } from "../spec.ts"
import { deckResults } from "./deck-checks.ts"
import { placeholderNote, writeDeckProject, type DeckProject } from "./deck-project.ts"
import { DECK_ENV_NAMES, deckCheck, deckPresent, deckSnapshot } from "./deck-run.ts"
import { checkHyperframes, freePort, tailOf } from "./hyperframes.ts"

// The three layers, re-exported so the package's one deck entry keeps every name it published before the split. A caller
// that wants a single layer can import `@omacode/artifact/adapters/deck-project` (or `-run`, `-checks`) instead.
export * from "./deck-checks.ts"
export * from "./deck-project.ts"
export * from "./deck-run.ts"

// The engine's own facts are shared with the video adapter (B2-T1), so the deck entry re-exports them from their new
// home rather than keeping a second copy that could answer differently.
export { checkHyperframes, hyperframesTool, HYPERFRAMES_INSTALL } from "./hyperframes.ts"
export type { HyperframesCheck } from "./hyperframes.ts"

// ---------------------------------------------------------------------------------------------------------------------
// The adapter (B3-T4), which is what B3's caller holds.
//
// The object keeps the four steps apart because the gate (B1-T7) runs them apart: `prepare` may fail on a machine that
// cannot make a deck before a job directory is dirtied, `snapshot` is the browser's slow pass a visual check reads, and
// `check` is one `hyperframes check` for the mechanical ones. The state between them — the project, the spec, the frames
// — lives in this closure rather than in a module, so two jobs in one process cannot see each other's slides.
//
// `network: true` is a permission for the presenter alone. Every other call this adapter makes leaves `network` unset,
// and the runner then keeps it wrapped (B1-T5): a check and a snapshot render a local file and need nothing from the
// host, while `present` serves a page the user's own browser has to reach.

// A path as the adapter interface wants it: relative to the job. The CLI reports its frames absolute, so they are
// rebased here; a path it reports outside the job is kept as it is rather than rewritten, because a name the checker
// cannot resolve is worth more than one this file invented.
function jobRelative(jobDir: string, path: string): string {
  const full = resolve(jobDir, path)
  if (!insidePath(jobDir, full)) return path
  return relative(resolve(jobDir), full) || "."
}

export function deckAdapter(): Adapter<DeckSpec> {
  let runner: HostRunner | undefined
  let spec: DeckSpec | undefined
  let project: DeckProject | undefined
  let shots: readonly string[] = []

  const built = (): DeckProject => {
    if (project === undefined) {
      throw new Error("deck: the adapter ran a step before prepare, so there is no project to work on")
    }
    return project
  }

  const asked = (): DeckSpec => {
    if (spec === undefined) throw new Error("deck: the adapter ran check before prepare, so there is no spec to check")
    return spec
  }

  return {
    kind: "deck",
    name: "hyperframes",
    version: "0.1.0",
    executables: ["hyperframes"],
    network: true,
    env: DECK_ENV_NAMES,

    // The engine is asked before anything is written. A machine without HyperFrames gets the install sentence from
    // `checkHyperframes` as a throw with no job directory touched, which is the difference between a job that failed and
    // a job that left half a deck behind. The notes name the version — a deck that travels should say which engine made
    // it — and, when a picture was missing, the placeholder note, so the deck is never quietly a deck with a box in it.
    async prepare(input, ctx) {
      runner = ctx.run
      const engine = await checkHyperframes(ctx.run)
      if (!engine.ok) throw new Error(engine.reason ?? "HyperFrames is not usable, so a deck could not be made")
      spec = input
      project = writeDeckProject(input, ctx.jobDir)
      const placeholder = placeholderNote(project)
      const notes = [
        `HyperFrames ${engine.version ?? "an unknown version"} made this deck`,
        ...(placeholder === undefined ? [] : [placeholder]),
      ]
      for (const note of notes) ctx.log(note)
      return { notes }
    },

    // A deck has no encode step: the project the writer laid out is the artifact. The files are job-relative names, the
    // form the manifest resolves.
    async render() {
      return { outputs: built().files }
    },

    // One frame per visible slide, asked for by the scene's own start, with the CLI's end-of-timeline frame turned off so
    // the count is the deck's and not one more. The frames are the project's scenes in time, so a hidden slide and a
    // branch slide are not photographed: they are not slides the room sees.
    async snapshot(ctx) {
      const current = built()
      const frames = current.scenes.filter((scene) => scene.branch === null)
      const taken = await deckSnapshot(ctx.run, ctx.jobDir, { at: frames.map((scene) => scene.start), end: false })
      if (taken.shots.length !== frames.length) {
        ctx.log(`deck snapshot: ${taken.shots.length} frames for ${frames.length} slides`)
        if (taken.output.trim()) ctx.log(tailOf(taken.output))
      }
      shots = taken.shots.map((path) => jobRelative(ctx.jobDir, path))
      return {
        shots: shots.map((path, index) => ({ path, label: frames[index]?.id ?? `frame ${index + 1}` })),
      }
    },

    // One check run for every mechanical and visual rule, because a second browser session would answer about a page that
    // is not the one the first looked at. `network` stays unset: the check reads a local file.
    async check(ctx, defs) {
      const current = built()
      const result = await deckCheck(ctx.run, ctx.jobDir)
      if (!result.ok) {
        const said = result.refused ?? (tailOf(result.output) || "exited with no output")
        ctx.log(`hyperframes check: ${said}`)
      }
      return deckResults({ spec: asked(), project: current, report: result.report, shots }, defs)
    },

    // The human's door (L3). A free port, then the presenter, which asks for the network itself: its server listens inside
    // the child's namespace, so only a networked run is reachable from the browser the user already has open.
    async openEditor(ctx) {
      built()
      const port = await freePort("deck")
      const present = await deckPresent(ctx.run, ctx.jobDir, port)
      if (!present.started) throw new Error(present.output)
      ctx.log(present.output)
    },

    // The way out of a presenter that is holding the runner. A cancelled run is not a failed one; the runner reports it
    // as a value, and the report can say the user closed the window.
    cancel() {
      runner?.cancel()
    },
  }
}
