// The deck adapter's room in the package (B3), and the entry point a caller imports: the one fact the adapter cannot
// invent — whether the engine that would make a deck is here at all — the tool row the deck carries, and the adapter
// object itself.
//
// HyperFrames is a precondition and not a dependency on another job, so this file owns the check and the licence row
// (B3-T0). The three concerns the adapter grew beside it live in their own modules: `deck-project.ts` writes the
// slideshow project and scans its assets (B3-T2), `deck-run.ts` asks the engine to check, snapshot and present it
// (B3-T3), and `deck-checks.ts` turns the engine's report into check results (B3-T4). Hence the name: the file
// is about a deck and not a check, and every name those modules export is re-exported below, so a caller and the tests
// still import a deck from one place.
//
// Nothing here looks for the program itself. It asks the host runner (B1-T5), the one place a program may be started,
// and the runner answers with a result rather than an exception: missing, refused and crashed all arrive the same way,
// and the sentence a user reads is built from that answer. There is no `child_process` import and no shell, because a
// check that could start a program on its own would be a second door past the allowlist the runner exists to keep.

import { createServer } from "node:net"
import { relative, resolve } from "node:path"

import type { Adapter, HostRunInput, HostRunner, HostRunResult } from "../adapter.ts"
import { insidePath } from "../paths.ts"
import type { ToolProvenance } from "../provenance.ts"
import type { DeckSpec } from "../spec.ts"
import { deckResults } from "./deck-checks.ts"
import { placeholderNote, writeDeckProject, type DeckProject } from "./deck-project.ts"
import { DECK_ENV_NAMES, deckCheck, deckPresent, deckSnapshot } from "./deck-run.ts"

// The three layers, re-exported so the package's one deck entry keeps every name it published before the split. A caller
// that wants a single layer can import `@omacode/artifact/adapters/deck-project` (or `-run`, `-checks`) instead.
export * from "./deck-checks.ts"
export * from "./deck-project.ts"
export * from "./deck-run.ts"

// How the engine is installed so that the runner can find it. The prefix matters: a global npm install under this
// machine's node prefix writes its bin into `~/.local/bin`, which is already on the PATH the runner searches, while a
// project-local install (node_modules) is a path the runner never looks in. The plugin cannot widen the runner's search
// path for one adapter — that would be the adapter changing the rule that constrains it — so the message names the
// install that fits the rule instead.
export const HYPERFRAMES_INSTALL = "npm i -g --prefix ~/.local hyperframes"

// The tool row a produced deck carries (B1-T3). HyperFrames is Apache-2.0, which places no restriction on where the
// result may be used, so the territory is "global" and not a guess. D18 records it anyway: a deck that leaves this
// machine must say which engine made it and under which terms, and "there is no restriction" is itself a term a reader
// should not have to infer from a missing field.
export function hyperframesTool(version: string): ToolProvenance {
  return { name: "hyperframes", version, license: "Apache-2.0", territory: "global" }
}

// The answer the adapter's `prepare` acts on. `version` is present exactly when `ok` is true, so a caller that has an
// ok check also has the version to hand `hyperframesTool`; `detail` is the diagnosis and never a second verdict.
export interface HyperframesCheck {
  readonly ok: boolean
  readonly version?: string
  readonly reason?: string
  readonly detail?: string
}

const VERSION_ARGS = ["--version"] as const
const DOCTOR_ARGS = ["doctor"] as const

// A semantic version, with the leading "v" some CLIs print allowed but not required: the command answers `0.9.54` here
// and a banner would say `hyperframes v0.9.54`, and both are the same fact for provenance. The first match is taken,
// because a version is what the output starts with; anything after it is the program describing itself.
const SEMVER = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/

// How many lines of `doctor` a failure carries. It is a table of environment facts; the first few are where the version,
// the binary and the runtime are, and the rest (optional transcribers, a Docker daemon a deck does not use) would turn a
// diagnosis into a wall of text in a message that is read once.
const DOCTOR_LINES = 6

// The end of an output, which is where a failure is. A whole browser log in a check's answer would bury the sentence
// above it, so the tail is kept and the front is dropped.
const TAIL_CHARS = 400

const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const tailOf = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length > TAIL_CHARS ? `…${trimmed.slice(-TAIL_CHARS)}` : trimmed
}

const nonEmptyLines = (text: string, count: number): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, count)

// What the failing run itself said, in the reader's words. A refusal is the runner saying the program never started, and
// its sentence already names the rule that stopped it (the allowlist, the search path, the missing wrapper); repeating it
// is more useful than replacing it with "missing", which would send the reader looking for the wrong problem.
function whatHappened(result: HostRunResult): string {
  if (result.refused) return result.refused
  if (result.cancelled) return "the run was cancelled"
  if (result.timedOut) return "the run timed out"
  const said = firstLine(result.stderr)
  return said ? `hyperframes --version exited ${result.code} (${said})` : `hyperframes --version exited ${result.code}`
}

// The sentence a user reads when the engine is not usable. It carries the install command because that is the way out:
// a message that only named the failure would leave the reader to discover the prefix rule above on their own.
const unusable = (happened: string): string =>
  `HyperFrames is missing or not runnable: ${happened}. Install it with: ${HYPERFRAMES_INSTALL}`

// Whether HyperFrames can make a deck on this machine, and which version would make it. The version is the gate: a
// program that runs and reports a version is usable, and everything else is a failure with a reason.
//
// `doctor` is the diagnosis and not the gate because it answers a different question. It reports optional extras — a
// transcriber, a local voice, a music model, a Docker daemon — that a deck does not need, and a deck maker that refused
// to run until those were installed would be stricter than the product. So a failure runs `doctor` once and keeps its
// first lines as `detail`; a `doctor` that also fails leaves the detail off, because the two runs failed at the same
// door and saying so twice is not more information.
//
// This is a read: no file, no directory, no environment is written anywhere. A check that left something behind would
// make the next run look different for a reason that was not the machine's.
export async function checkHyperframes(run: HostRunner): Promise<HyperframesCheck> {
  const input: HostRunInput = { exe: "hyperframes", args: [...VERSION_ARGS] }
  const probe = await run.run(input)

  // The version may arrive on either stream: a CLI that banners to stdout and one that prints a version to stderr are
  // both telling the same fact, and a check that only read stdout would refuse a working program.
  const found = probe.passed ? SEMVER.exec(`${probe.stdout}\n${probe.stderr}`) : null
  if (found) return { ok: true, version: found[1]! }

  const detail: string[] = []
  let reason: string
  if (probe.passed) {
    // The program started, so it is installed; what it printed is not a version. That is a different failure from a
    // missing binary, and the message says what was printed rather than sending the reader to install it again.
    reason = "HyperFrames is installed but hyperframes --version printed no version, so a deck could not say which engine made it"
    const printed = tailOf(`${probe.stdout}\n${probe.stderr}`)
    if (printed) detail.push(printed)
  } else {
    reason = unusable(whatHappened(probe))
  }

  const doctor = await run.run({ exe: "hyperframes", args: [...DOCTOR_ARGS] })
  if (doctor.passed) detail.push(...nonEmptyLines(doctor.stdout || doctor.stderr, DOCTOR_LINES))

  return { ok: false, reason, ...(detail.length > 0 ? { detail: detail.join("\n") } : {}) }
}

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

// A free TCP port: bind 0, read the number the kernel chose, close, hand the number over. `present` needs a port and a
// fixed one collides with whatever else the user is running; the close before the hand-off leaves the small race every
// port probe has, and the presenter's own start check is what reports a lost one.
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once("error", (error) =>
      fail(new Error(`deck: could not find a free port: ${error instanceof Error ? error.message : String(error)}`)),
    )
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) done(port)
        else fail(new Error("deck: the free port probe answered with no port"))
      })
    })
  })
}

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
      const port = await freePort()
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
