// The deck adapter's room in the package (B3). It starts with the one fact the adapter cannot invent: whether the engine
// that would make a deck is here at all. HyperFrames is a precondition and not a dependency on another job, so this file
// owns the check and the licence row (B3-T0) and the slideshow project that uses them (B3-T2): the composition, the
// island that says which scene is which slide, and the check, snapshot and present runs. That is why the file is named
// for the deck rather than for the check.
//
// Nothing here looks for the program itself. It asks the host runner (B1-T5), the one place a program may be started,
// and the runner answers with a result rather than an exception: missing, refused and crashed all arrive the same way,
// and the sentence a user reads is built from that answer. There is no `child_process` import and no shell, because a
// check that could start a program on its own would be a second door past the allowlist the runner exists to keep.

import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { connect, createServer } from "node:net"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { Adapter, HostRunInput, HostRunner, HostRunResult } from "../adapter.ts"
import { CONTRACT_CHECKS, SKIPPED_CODE, type CheckDef, type CheckResult } from "../checks.ts"
import { insidePath } from "../paths.ts"
import { blankFrame, readPng } from "../png.ts"
import type { ToolProvenance } from "../provenance.ts"
import type { DeckSpec, Slide } from "../spec.ts"

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
// The slideshow project (B3-T2).
//
// A deck is not a video: it is presented and snapshotted, never encoded. The project this file writes is therefore the
// smallest thing HyperFrames can serve and photograph — a composition whose scenes are the slides, plus the slideshow
// island that tells the player which scene is which slide. The shape below was read out of the installed player, not
// guessed, and the notes beside each field say what the player does with it.
//
// Everything the project needs is inline. The example project HyperFrames scaffolds loads GSAP from a CDN; a deck made
// here runs with the network unshared (B1-T5), so an external script would be a slide that never moves. The only script
// a project carries is the island and the empty timeline registration the static guard insists on.
//
// The job directory is the only place written. Every name in a project is either fixed here or an id the spec carried,
// and both are checked before a byte is written: a slide id is a scene id, a DOM id and an attribute value at once, and
// an asset path is a relative URL, so an id or asset that could leave the job is refused rather than escaped.

// What the player calls the timeline the deck starts on. A composition root needs a `data-composition-id`, and the
// slideshow keeps the main line apart from its `slideSequences` under this same name (spec.ts refuses a branch called
// `main` for that reason, so the root and the player agree without a second spelling).
const MAIN_COMPOSITION = "deck"

// The canvas and the time a slide occupies. A deck is a sequence of still scenes, so a fixed window is honest: every
// slide is on screen for the same number of seconds, and the player seeks within that window for a reveal. Eight seconds
// leaves room for two or three reveal steps without turning a five-slide deck into a minute-long film.
const SLIDE_WIDTH = 1920
const SLIDE_HEIGHT = 1080
const SLIDE_SECONDS = 8

// A slide id is used as `data-composition-id`, as an `id` attribute and as the scene id in the island, so it is held to
// what all three accept without quoting: a letter or digit, then letters, digits, ".", "_" or "-". `../` cannot pass,
// and neither can a quote that would end an attribute. The contract (spec.ts) only requires a non-empty string, because
// it does not know what an adapter will do with the id; this is the adapter's own refusal.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// What the player calls a slide in its manifest. The player resolves `fragments` against the scene's window in seconds
// and its `hotspots` against the branch ids in `slideSequences`; a hotspot to an unknown sequence is a manifest error in
// the browser console, so the target is checked here where a message can name the slide.
interface IslandHotspot {
  readonly id: string
  readonly label: string
  readonly target: string
}

// `fragments` is required by the player's validator to be an array of numbers when present, so it is always written as
// an array; the sorted order is the player's (it re-sorts anyway), and an empty array is the same as none.
interface IslandSlide {
  readonly sceneId: string
  readonly fragments: readonly number[]
  readonly hotspots: readonly IslandHotspot[]
  readonly notes?: string
}

// A branch is a sequence of slides the player can enter from a hotspot. Its `id` is the hotspot's `target`, which is why
// it is checked against the same safe-id rule as a scene: it travels into the manifest, not into the HTML.
interface IslandSequence {
  readonly id: string
  readonly label: string
  readonly slides: readonly IslandSlide[]
}

// The island as the player expects it: `{ slides[], slideSequences[] }`. The element `hyperframes present` builds takes
// the composition from the player and these two lists from the island; the player emits a "scenes" event with the
// nested compositions it found, and the slideshow matches `sceneId` against that list.
export interface DeckIsland {
  readonly slides: readonly unknown[]
  readonly slideSequences: readonly unknown[]
}

// Why a slide's asset is drawn as a placeholder instead of a picture. The three cases are the ones the writer can see
// without opening the file: it is not there, it is there but not a file, or it is a file larger than a deck will embed.
// The reason travels beside the asset's path so a report can say which of the three happened, while the page itself says
// the same thing in all three — the slide is missing its picture.
export type AssetFault = "missing" | "not a file" | "too large"

// One asset the project could not use, by the slide that names it. A slide id and an asset path are enough to find the
// slot again in the spec, and `why` is what the later `deck.assets` check (B3-T4) reports so a deck that was presented
// with a labelled box is never mistaken for one that was rendered.
export interface DeckPlaceholder {
  readonly slide: string
  readonly asset: string
  readonly why: AssetFault
}

export interface DeckProject {
  readonly dir: string
  readonly files: readonly string[]
  readonly slides: number
  readonly island: DeckIsland
  readonly scenes: readonly DeckScene[]
  readonly placeholders: readonly DeckPlaceholder[]
}

// One scene in time. Hidden slides are not scenes (they are kept in the HTML, hidden), so the only scenes are the
// visible main line and the branch slides; the latter come after the main line because a branch is entered from a
// slide, and the player seeks to the scene's own window wherever it lies.
//
// `branch` is the id of the branch a scene belongs to, or null on the main line. The checks need to tell the two apart —
// a snapshot is taken of the main line, because that is the deck the room sees — and carrying the id here means neither
// a caller nor a check has to re-derive it from the order of two lists.
interface Scene {
  readonly slide: Slide
  readonly start: number
  readonly branch: string | null
}

// A scene as the project reports it (B3-T4): the id the island refers to, the second it starts at, and the branch it
// belongs to. This is what `snapshot` seeks to, so a deck cannot have a scene the project writes and the adapter does not
// photograph.
export interface DeckScene {
  readonly id: string
  readonly start: number
  readonly branch: string | null
}

// A value as the writer gave it, for the refusals where the value itself is the diagnosis. The rest of this file names
// the field; this names what was in it.
const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

// Why a slide's asset cannot be used as a URL in the project. The contract already refuses an absolute path and a "..";
// this repeats the rule for a spec that reached the adapter through a cast, and it says what is wrong in the adapter's
// own words. The test is on the path's text, like spec.ts: a lexical rule, so a spec can be refused before a job
// directory exists. `scanAssets` below applies the same rule to the real file once the job is known.
function assetProblem(value: string): string | undefined {
  if (!value) return "is empty"
  if (isAbsolute(value)) return "is absolute, but a deck asset is relative to the job directory"
  if (value.includes("\\")) return 'uses "\\" as a separator'
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'has an empty, "." or ".." segment'
  }
  return undefined
}

// Everything that would make the written project disagree with the spec or leave the job. One function so the refusal
// is a sentence and not a partly written project: it runs before the first directory is made.
function deckProblem(spec: DeckSpec): string | undefined {
  if (spec.kind !== "deck") return `it is a ${shown(spec.kind)} spec, not a deck`
  const branches = spec.branches ?? []
  const branchIds = new Set<string>()
  for (const branch of branches) {
    if (!SAFE_ID.test(branch.id)) return `branch id ${shown(branch.id)} is not a safe scene id (${SAFE_ID.source})`
    if (branch.id === "main") return `branch id "main" is the player's own id for the main line`
    if (branchIds.has(branch.id)) return `branch id ${shown(branch.id)} is used twice`
    branchIds.add(branch.id)
  }

  const slides = [...spec.slides, ...branches.flatMap((branch) => branch.slides)]
  if (slides.length === 0) return "it has no slides, so a project would show nothing"
  const visible = spec.slides.filter((slide) => slide.hidden !== true)
  if (visible.length === 0 && branches.length === 0) return "every slide is hidden, so a project would show nothing"

  const slideIds = new Set<string>()
  for (const slide of slides) {
    if (!SAFE_ID.test(slide.id)) return `slide id ${shown(slide.id)} is not a safe scene id (${SAFE_ID.source})`
    if (slideIds.has(slide.id)) return `slide id ${shown(slide.id)} is used twice`
    slideIds.add(slide.id)
    if (slide.asset !== undefined) {
      const problem = assetProblem(slide.asset)
      if (problem) return `slide ${shown(slide.id)}: asset ${shown(slide.asset)} ${problem}`
    }
  }

  // A hotspot is a button the player wires to a sequence, so a target that is not one of this deck's branches is a dead
  // button. The contract checks it too; this is the refusal for a spec that did not go through the parser.
  for (const slide of slides) {
    for (const hotspot of slide.hotspots ?? []) {
      if (!branchIds.has(hotspot.target)) {
        return `slide ${shown(slide.id)}: hotspot ${shown(hotspot.id)} names no branch (${shown(hotspot.target)})`
      }
    }
  }
  return undefined
}

// The largest asset a deck will point at. An `<img>` in a slide is loaded by the browser the presenter runs, and a file
// past this size turns a deck that opens in a moment into one that does not — a 4K still is a few megabytes, a video
// masquerading as an image is not. The cap is a limit, not a resize: this adapter has no image library, so a picture it
// will not embed becomes a placeholder and a scaled copy would be a second artifact nobody asked for.
export const MAX_ASSET_BYTES = 32 * 1024 * 1024

// What `writeDeckProject` may be told about assets. The cap is a parameter because the failure has to be testable without
// writing 32 MiB into a temporary directory; production callers leave it alone and get `MAX_ASSET_BYTES`.
export interface DeckWriteOptions {
  readonly maxAssetBytes?: number
}

// Every slide the project writes, in the order it writes them: the main line as the author wrote it (hidden slides
// included, because they are in the HTML) and then each branch's slides. The asset scan walks this list rather than the
// scenes, because a scene is only the visible part and a hidden slide's picture is just as missing.
const slidesOf = (spec: DeckSpec): readonly Slide[] => [
  ...spec.slides,
  ...(spec.branches ?? []).flatMap((branch) => branch.slides),
]

// Why an asset at a resolved path is not usable, or undefined when it is. The file is stat'ed and never read: the
// browser is the reader, and a deck writer that loaded every image would spend a job's memory to learn a file's size.
// Anything `stat` cannot answer is "missing", because from the deck's point of view a file it cannot see is not there.
function faultOf(target: string, maxBytes: number): AssetFault | undefined {
  let stats
  try {
    stats = statSync(target)
  } catch {
    return "missing"
  }
  // A symlink is followed by `stat`, so a link to a file inside the job is a file; a link to a directory, or a directory
  // the spec happened to name, is not something an `<img>` can show.
  if (!stats.isFile()) return "not a file"
  if (stats.size > maxBytes) return "too large"
  return undefined
}

// The asset verdicts for one project: which slides lose their picture, and why. A path that resolves outside the job —
// a symlink inside it pointing out — is refused here rather than written: spec.ts applies that rule to the path's text,
// and this is the same rule applied to the file the text now names. The refusal happens before the first directory is
// made, so a deck that could show something from outside the job leaves no project behind.
function scanAssets(
  spec: DeckSpec,
  dir: string,
  maxBytes: number,
): { readonly faults: ReadonlyMap<string, AssetFault>; readonly placeholders: readonly DeckPlaceholder[] } {
  const faults = new Map<string, AssetFault>()
  const placeholders: DeckPlaceholder[] = []
  for (const slide of slidesOf(spec)) {
    const asset = slide.asset
    if (asset === undefined) continue
    const target = resolve(dir, asset)
    if (!insidePath(dir, target)) {
      throw new Error(`deck: slide ${shown(slide.id)}: asset ${shown(asset)} resolves outside the job directory`)
    }
    const why = faultOf(target, maxBytes)
    if (why === undefined) continue
    faults.set(slide.id, why)
    placeholders.push({ slide: slide.id, asset, why })
  }
  return { faults, placeholders }
}

// One line for a report, and nothing when every picture is there. The checks (B3-T4) call this so a placeholder is
// accepted and named at the same time: a deck with a labelled box is presentable, but it is not a deck that was rendered,
// and a reader must be able to tell the two apart from the report alone.
export function placeholderNote(project: DeckProject): string | undefined {
  const { placeholders } = project
  if (placeholders.length === 0) return undefined
  const list = placeholders.map((slot) => `${slot.asset} (${slot.why})`).join(", ")
  return `${placeholders.length} ${placeholders.length === 1 ? "placeholder" : "placeholders"}: ${list}`
}

// The scenes in time: the visible main line first, then every branch's slides, each taking one window. A hidden slide in
// a branch is still part of that branch — a branch is only seen by entering it, so `hidden` can only mean "not on the
// main line", and the main line is the list that honours it.
function layout(spec: DeckSpec): readonly Scene[] {
  const visible = spec.slides.filter((slide) => slide.hidden !== true).map((slide) => ({ slide, branch: null }))
  const branchSlides = (spec.branches ?? []).flatMap((branch) =>
    branch.slides.map((slide) => ({ slide, branch: branch.id })),
  )
  return [...visible, ...branchSlides].map((entry, index) => ({ ...entry, start: index * SLIDE_SECONDS }))
}

// A time the player can seek to, with milliseconds kept and trailing zeros dropped, so the same spec always writes the
// same bytes and a reveal lands on a number a person can read in the manifest.
const timeOf = (seconds: number): number => Math.round(seconds * 1000) / 1000
const numberText = (value: number): string => String(timeOf(value))

// The times a slide's reveals uncover. The spec says `reveals` as build indices; the player wants absolute seconds and
// validates them against the scene's window. A reveal is a step, so the window is divided into one more step than there
// are reveals and the k-th sorted reveal is the end of step k+1: [0, 1] on an eight-second slide lands at 2.67 s and
// 5.33 s, both inside the slide, and the order the author wrote is irrelevant because the player reads a set.
function fragmentTimes(slide: Slide, start: number): number[] {
  const reveals = slide.reveals ?? []
  if (reveals.length === 0) return []
  const ordered = [...reveals].sort((left, right) => left - right)
  const step = SLIDE_SECONDS / (ordered.length + 1)
  return ordered.map((_, position) => timeOf(start + (position + 1) * step))
}

// One slide as the player reads it. `fragments` and `hotspots` are always present (the manifest is easier to read and
// the validator accepts an empty array), while `notes` appears only when the spec had them: a missing note and an empty
// note are the same to the presenter, and writing one nobody wrote would make the project say more than the spec.
function islandSlide(slide: Slide, start: number): IslandSlide {
  return {
    sceneId: slide.id,
    fragments: fragmentTimes(slide, start),
    hotspots: (slide.hotspots ?? []).map((hotspot) => ({
      id: hotspot.id,
      label: hotspot.label,
      target: hotspot.target,
    })),
    ...(slide.notes !== undefined ? { notes: slide.notes } : {}),
  }
}

function islandFor(spec: DeckSpec, scenes: readonly Scene[]): DeckIsland {
  const starts = new Map(scenes.map((scene) => [scene.slide.id, scene.start]))
  const slides = spec.slides
    .filter((slide) => slide.hidden !== true)
    .map((slide) => islandSlide(slide, starts.get(slide.id) ?? 0))
  const slideSequences = (spec.branches ?? []).map(
    (branch): IslandSequence => ({
      id: branch.id,
      label: branch.label,
      slides: branch.slides.map((slide) => islandSlide(slide, starts.get(slide.id) ?? 0)),
    }),
  )
  return { slides, slideSequences }
}

// Text that is safe where it lands: in a heading, in a paragraph, in an attribute. A title is the author's prose, so it
// is escaped rather than restricted; only ids are restricted, because they are addresses.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// The JSON in a `<script>` element. Escaping every "<" keeps a title that contains "</script>" from ending the element;
// the JSON parser sees the same string either way.
const islandText = (island: DeckIsland): string =>
  JSON.stringify(island, null, 2).replace(/</g, "\\u003c")

const STYLE = `
      :root {
        --ground: #101014;
        --ink: #f5f5f7;
        --muted: #b9b9c2;
        --accent: #7aa2ff;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${SLIDE_WIDTH}px;
        height: ${SLIDE_HEIGHT}px;
        overflow: hidden;
        background: var(--ground);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
      }
      #${MAIN_COMPOSITION} { position: relative; width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; }
      .slide {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 28px;
        padding: 120px 160px;
      }
      .slide h2 {
        font-size: 72px;
        font-weight: 650;
        letter-spacing: -0.025em;
        line-height: 1.1;
        max-width: 1500px;
        overflow-wrap: anywhere;
      }
      .slide p {
        font-size: 32px;
        line-height: 1.45;
        color: var(--muted);
        max-width: 1400px;
        white-space: pre-line;
        overflow-wrap: anywhere;
      }
      .slide .asset {
        max-width: 900px;
        max-height: 420px;
        object-fit: contain;
        border-radius: 12px;
      }
      .slide .asset-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 900px;
        min-height: 220px;
        padding: 32px;
        border: 4px dashed var(--muted);
        border-radius: 12px;
        color: var(--muted);
        font-size: 26px;
        line-height: 1.4;
        text-align: center;
        overflow-wrap: anywhere;
      }
      .slide .rule { width: 96px; height: 6px; background: var(--accent); border-radius: 3px; }
      .is-hidden { display: none; }
`

// The asset block a slide carries: the picture when the file is there, and a labelled box when it is not. The box says
// the path rather than a generic "image missing", because the person fixing the deck needs to know which slot to fill;
// `data-deck-placeholder` is the same fact for the check, which accepts the slide but names it in the report. Both forms
// are produced here so a visible slide and a hidden one cannot disagree about what a missing asset looks like.
function assetLines(slide: Slide, fault: AssetFault | undefined): string[] {
  if (slide.asset === undefined) return []
  const asset = escapeHtml(slide.asset)
  if (fault === undefined) {
    return [`        <img class="asset" src="${asset}" alt="${escapeHtml(slide.title ?? "")}" />`]
  }
  return [`        <div class="asset-placeholder" data-deck-placeholder="${asset}">missing asset: ${asset}</div>`]
}

// One visible slide as a nested composition: the runtime reads the id, start and duration off a `[data-composition-id]`
// element inside the root, emits it as a scene, and shows only the scene whose window contains the playhead. The title
// and body are real text, so the page is readable without any script at all.
function sceneHtml(scene: Scene, track: number, faults: ReadonlyMap<string, AssetFault>): string {
  const { slide, start } = scene
  const lines = [
    `      <section id="slide-${slide.id}" class="clip slide" data-composition-id="${slide.id}" data-start="${numberText(start)}" data-duration="${SLIDE_SECONDS}" data-width="${SLIDE_WIDTH}" data-height="${SLIDE_HEIGHT}" data-track-index="${track}">`,
    '        <div class="rule"></div>',
  ]
  if (slide.title !== undefined) lines.push(`        <h2>${escapeHtml(slide.title)}</h2>`)
  if (slide.body !== undefined) lines.push(`        <p>${escapeHtml(slide.body)}</p>`)
  lines.push(...assetLines(slide, faults.get(slide.id)))
  lines.push("      </section>")
  return lines.join("\n")
}

// A hidden slide is kept where a person and a grep can find it and is not a scene: no `data-composition-id`, no window,
// no place in the island. The `hidden` attribute is what keeps it off the stage, so a deck with a plan-B slide presents
// exactly the slides that were meant for the room.
function hiddenHtml(slide: Slide, faults: ReadonlyMap<string, AssetFault>): string {
  const lines = [`      <section id="hidden-${slide.id}" class="slide is-hidden" data-slide-id="${slide.id}" hidden>`]
  if (slide.title !== undefined) lines.push(`        <h2>${escapeHtml(slide.title)}</h2>`)
  if (slide.body !== undefined) lines.push(`        <p>${escapeHtml(slide.body)}</p>`)
  lines.push(...assetLines(slide, faults.get(slide.id)))
  lines.push("      </section>")
  return lines.join("\n")
}

function htmlFor(
  spec: DeckSpec,
  scenes: readonly Scene[],
  island: DeckIsland,
  faults: ReadonlyMap<string, AssetFault>,
): string {
  const total = scenes.length * SLIDE_SECONDS
  const body = [
    ...scenes.map((scene, track) => sceneHtml(scene, track, faults)),
    ...spec.slides.filter((slide) => slide.hidden === true).map((slide) => hiddenHtml(slide, faults)),
  ].join("\n")
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${SLIDE_WIDTH}, height=${SLIDE_HEIGHT}" />
    <title>${escapeHtml(spec.job)}</title>
    <style>${STYLE}    </style>
  </head>
  <body>
    <div id="${MAIN_COMPOSITION}" data-composition-id="${MAIN_COMPOSITION}" data-root="true" data-start="0" data-duration="${total}" data-width="${SLIDE_WIDTH}" data-height="${SLIDE_HEIGHT}">
${body}
    </div>
    <script type="application/hyperframes-slideshow+json">
${islandText(island)}
    </script>
    <script>
      // The static guard requires a registered timeline for the composition. This deck has no tween to register: a slide
      // is a cut between static scenes, and the runtime moves the playhead. The empty object is the registration.
      window.__timelines = window.__timelines || {};
      window.__timelines["${MAIN_COMPOSITION}"] = {
        seek: function () {},
        play: function () {},
        pause: function () {},
      };
    </script>
  </body>
</html>
`
}

// The project's two side files. The registry is omitted rather than pointed at a URL: a project that runs with the
// network unshared must not carry an address it would fetch a block from, and this deck has no block to fetch. `meta`
// names the project for the tools that read it; the job id is the only name the spec gives, and it is written as data.
const PROJECT_JSON = `${JSON.stringify(
  {
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
  },
  null,
  2,
)}\n`

const metaJson = (job: string): string => `${JSON.stringify({ id: job, name: job }, null, 2)}\n`

// Write one project for one spec. The same spec always writes the same three files: no clock, no random id, no program.
// They are 0600 beside a 0700 job, and every path is joined to the job directory from a fixed name, so there is nothing
// in a spec that can choose where a byte lands.
//
// An asset is the one thing the project points at rather than writes, so the job is asked about it before the project
// exists: a file inside the job becomes an `<img>`, and a missing, non-file or oversized one becomes a labelled
// placeholder instead of a broken image. The asset scan runs before `mkdirSync` so the one asset that is a refusal (a
// link out of the job) leaves no half-written project behind.
//
// `files` is relative to `dir`, the form the adapter interface (B1-T4) and the manifest (B1-T3) resolve. `slides` is the
// number of main-line slides the island carries, which is what `hyperframes present` will count; hidden slides are kept
// in the HTML and are not part of that number.
export function writeDeckProject(spec: DeckSpec, jobDir: string, opts: DeckWriteOptions = {}): DeckProject {
  const problem = deckProblem(spec)
  if (problem !== undefined) throw new Error(`deck: ${problem}`)

  const dir = resolve(jobDir)
  const { faults, placeholders } = scanAssets(spec, dir, opts.maxAssetBytes ?? MAX_ASSET_BYTES)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const scenes = layout(spec)
  const island = islandFor(spec, scenes)
  const files: ReadonlyArray<readonly [string, string]> = [
    ["index.html", htmlFor(spec, scenes, island, faults)],
    ["hyperframes.json", PROJECT_JSON],
    ["meta.json", metaJson(spec.job)],
  ]
  for (const [name, text] of files) {
    const path = join(dir, name)
    writeFileSync(path, text, { mode: 0o600 })
    chmodSync(path, 0o600)
  }

  return {
    dir,
    files: files.map(([name]) => name),
    slides: island.slides.length,
    island,
    // The scenes as the caller may hold them: ids and seconds, and no slide body. A snapshot seeks to `start`, and a
    // check asks which of these are the main line, so neither has to read the HTML or the island.
    scenes: scenes.map(({ slide, start, branch }) => ({ id: slide.id, start, branch })),
    placeholders,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Running the project through the host runner.
//
// The three functions below never start a program themselves; they ask the runner (B1-T5), which owns the allowlist, the
// environment, the working directory and the network. Each answer is a result: a refusal, a crash and an unparseable
// envelope all arrive as a value with the output attached, because a job that crashed is still a job to report.

// Chrome is found under `$HOME/.cache/hyperframes/chrome` (or `HYPERFRAMES_CACHE_DIR`, which the runner does not hand
// on: it is not on the sandbox's environment allowlist and a run cannot add to it). Under the runner HOME is
// `<job>/.home`, so on a machine that already has the managed headless shell, the job's cache is a link to the real one.
// A link is a directory entry inside the job and the cache behind it is only read; without it the CLI falls back to a
// system Chrome, which is slower and may not exist. A link that cannot be made is not a refusal: the run says what the
// CLI found, and that sentence is better than one this function invented.
function ensureBrowserCache(jobDir: string): void {
  const real = process.env["HYPERFRAMES_CACHE_DIR"]?.trim() || join(homedir(), ".cache", "hyperframes")
  const cache = join(real, "chrome")
  const home = join(resolve(jobDir), ".home", ".cache", "hyperframes")
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    symlinkSync(cache, join(home, "chrome"), "dir")
  } catch {
    // Already linked (EEXIST), no cache on this machine, or a host that will not make the link. The CLI resolves Chrome
    // on its own either way; this is the fast path, not a rule.
  }
}

// The JSON envelope a command prints, or nothing. The CLI writes its progress to stderr and the envelope to stdout, but
// a future version could frame it with a line, so the first object is taken rather than demanding that stdout be JSON
// from its first byte.
function envelopeOf(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// What a run said, both streams, for the message a reader gets. The whole output is kept because the JSON envelope is
// the report and the stderr tail is where a refusal that never became JSON is.
const outputOf = (result: HostRunResult): string =>
  [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n")

export interface DeckCheck {
  readonly ok: boolean
  readonly report?: unknown
  readonly output: string
  readonly refused?: string
}

// The flag that decides which GPU path the browser a check starts will take. The help says it plainly: "pass
// --no-browser-gpu for deterministic SwiftShader". Determinism is the first reason: a deck check wants the same pixels on
// every machine, so a slide's contrast, overflow and blankness are facts about the deck and not about the graphics driver
// that drew it.
//
// The second reason is this host. The auto-detected path launches `chrome-headless-shell` with
// `--use-gl=angle --use-angle=gl-egl --disable-software-rasterizer`, and that child aborts with SIGTRAP on every run: the
// user's coredump store filled with dumps that all point at our own temp job directories, and each one fires their crash
// notifier. The same command on a fresh project with this flag leaves no dump, so the hardware path is one source of the
// noise and a check avoids it by asking for software.
//
// The second, larger source was Chrome's own sandbox: inside bubblewrap it cannot build one and dies with
// `FATAL: No usable sandbox!`, one SIGTRAP per browser session. HyperFrames normally notices a container by
// `/.dockerenv` or `/run/.containerenv` and passes `--no-sandbox` itself; bwrap leaves neither marker, so the engine
// does not know. Its documented switch for exactly this is `HYPERFRAMES_CHROME_SANDBOX=0`, and passing it through the
// runner's declared-env channel turns the noise off: measured with a real deck check, two dumps before and none after,
// with the browser actually running (`browserSkipped: false`, contrast checked). Chrome without its own sandbox is
// running inside ours, which is the layering a container wants.
//
// `--no-browser-gpu` stays for the determinism it gives on its own: software rendering makes a check's pixels the same
// on every machine, which is what a visual check is worth.
const BROWSER_GPU_ARGS = ["--no-browser-gpu"] as const

// The names the adapter declares and the values its runs hand them. A name is here because a run needs it; the value is
// here because this adapter, not the host environment, knows what it should be.
export const DECK_ENV_NAMES = ["HYPERFRAMES_CHROME_SANDBOX"] as const
const DECK_ENV = { HYPERFRAMES_CHROME_SANDBOX: "0" } as const

// `hyperframes check --json` in the job directory. `ok` is the project's verdict, not the exit code's: the envelope's
// own `ok` is what says the deck is ready, and a run that exits zero while printing a failure envelope is still a
// failure. A refusal from the runner and an envelope that cannot be parsed are both `ok: false` with the reason in
// `refused`, never a throw, so a caller's report can carry the sentence.
export async function deckCheck(run: HostRunner, jobDir: string): Promise<DeckCheck> {
  ensureBrowserCache(jobDir)
  const result = await run.run({ exe: "hyperframes", args: ["check", "--json", ...BROWSER_GPU_ARGS], env: DECK_ENV })
  const output = outputOf(result)
  if (result.refused) return { ok: false, output, refused: result.refused }

  const report = envelopeOf(result.stdout)
  if (report === undefined) {
    return {
      ok: false,
      output,
      refused: `hyperframes check --json printed no JSON envelope${result.passed ? "" : ` (exit ${result.code})`}`,
    }
  }
  const verdict = recordOf(report)
  return { ok: result.passed && verdict?.["ok"] === true, report, output }
}

export interface DeckSnapshot {
  readonly shots: readonly string[]
  readonly output: string
}

// What a snapshot was asked for. `at` is the moments; `end` is the CLI's end-of-timeline frame, which is on by default
// there and off here when a caller has already named every scene. One frame per slide is the point of a per-slide
// snapshot (B3-T4): an extra frame at 47.75 s is a slide the deck does not have, and a check counting frames against
// slides would call a correct deck wrong.
export interface DeckSnapshotOptions {
  readonly at?: readonly number[]
  readonly end?: boolean
}

// `hyperframes snapshot --json`, with `--at` when the caller named the moments. The paths are what the CLI reported, in
// the form it reported them (this version prints them absolute, under the project's `.hyperframes/artifacts`), because
// rewriting a path the CLI already resolved would hide where the file really is. A refusal or an unreadable envelope
// yields no shots and the output carries the reason: there is no shot to invent.
export async function deckSnapshot(
  run: HostRunner,
  jobDir: string,
  opts: DeckSnapshotOptions = {},
): Promise<DeckSnapshot> {
  const args = ["snapshot", "--json", ...BROWSER_GPU_ARGS]
  if (opts.end === false) args.push("--no-end")
  const at = opts.at
  if (at !== undefined) {
    if (at.length === 0 || at.some((second) => !Number.isFinite(second) || second < 0)) {
      return { shots: [], output: `deck: --at takes non-negative seconds, got ${shown(at)}` }
    }
    args.push("--at", at.map(numberText).join(","))
  }

  ensureBrowserCache(jobDir)
  const result = await run.run({ exe: "hyperframes", args, env: DECK_ENV })
  const output = outputOf(result)
  if (result.refused) return { shots: [], output }

  const envelope = recordOf(envelopeOf(result.stdout))
  const frames = envelope?.["frames"]
  if (!Array.isArray(frames)) return { shots: [], output }
  const shots: string[] = []
  for (const frame of frames) {
    const path = recordOf(frame)?.["path"]
    if (typeof path === "string" && path.length > 0) shots.push(path)
  }
  return { shots, output }
}

export interface DeckPresent {
  readonly started: boolean
  readonly output: string
}

// How long the presenter is given to answer and how often the port is tried. The server is a few hundred milliseconds
// on this machine; twelve seconds is generous for a cold start and short enough that a broken run fails a test instead
// of hanging it.
const PRESENT_START_MS = 12_000
const PRESENT_POLL_MS = 100
const PRESENT_CONNECT_MS = 400

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// Whether something accepts a TCP connection on the port. The presenter's page is a normal HTTP server, so a connection
// is the cheapest proof it is up; the caller fetches the page itself when it wants the body.
function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port })
    let finished = false
    const finish = (answer: boolean): void => {
      if (finished) return
      finished = true
      socket.destroy()
      done(answer)
    }
    socket.setTimeout(PRESENT_CONNECT_MS, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

// `hyperframes present <job> --no-open --port <port>`, returned once the port answers. The run itself is not awaited:
// the runner is one-run-at-a-time by design, so a presented deck occupies it until the caller calls `run.cancel()`, and
// a function that awaited the server would never return. That is the contract the adapter relies on — the presenter is
// the job's foreground, and cancelling it is how the job ends.
//
// The job is presented with the network declaration its runner was built with. A presenter is a local HTTP server that
// the user's browser has to reach, so a runner with the network unshared can start it but nothing outside its namespace
// can open the page; the caller that wants to look at a deck builds that runner with the network shared.
//
// On a timeout the run is cancelled here, because a caller that got `started: false` has no process to cancel and the
// runner would otherwise stay busy. On a refusal nothing is started and the sentence is the output.
export async function deckPresent(run: HostRunner, jobDir: string, port: number): Promise<DeckPresent> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { started: false, output: `deck: port ${shown(port)} is not a TCP port` }
  }

  // The presenter's server listens inside the child's namespace, so it is reachable from the user's browser only when
  // the run asks for the host network. Every other call this adapter makes leaves it out and stays wrapped.
  const input: HostRunInput = {
    exe: "hyperframes",
    args: ["present", resolve(jobDir), "--no-open", "--port", String(port)],
    network: true,
  }
  let settled: HostRunResult | undefined
  let failed: string | undefined
  // Both halves are handled, so the promise this function leaves behind can never become an unhandled rejection: the run
  // resolves when the caller cancels, and a runner that throws instead is still a start that did not happen.
  const pending = run.run(input).then(
    (result) => {
      settled = result
      return result
    },
    (error: unknown) => {
      failed = error instanceof Error ? error.message : String(error)
      return undefined
    },
  )

  const deadline = Date.now() + PRESENT_START_MS
  while (Date.now() < deadline && settled === undefined && failed === undefined) {
    if (await portAnswers(port)) return { started: true, output: `hyperframes present is listening on port ${port}` }
    await wait(PRESENT_POLL_MS)
  }

  if (settled === undefined && failed === undefined) {
    // The port never answered and the process is still alive: stop it so the runner is free, then report what it said.
    run.cancel()
  }
  const result = settled ?? (await pending)
  const said = result ? outputOf(result) : ""
  const why =
    failed ??
    result?.refused ??
    (result?.cancelled ? "the presenter was stopped before it answered" : `the presenter did not answer on port ${port}`)
  return { started: false, output: said ? `${why}\n${said}` : why }
}

// ---------------------------------------------------------------------------------------------------------------------
// The deck's checks (B3-T4).
//
// A deck is worth presenting when the five things this file already knows are true of it — the slides the island names
// are the slides the spec has, a note hangs off each one, a hotspot lands on a branch, every reference resolves, and a
// missing picture is a labelled box rather than a gap — and when the four things only a browser can see are true too:
// nothing overflows, the text passes contrast, the page throws nothing, and every frame has something on it. The first
// group is a mapping over the spec and the project; the second is read out of one `hyperframes check` envelope.
//
// The mapping is a function of values, not of the engine: `deckResults` is given the spec, the project, the report and
// the snapshot paths, and says what follows. That is what makes a rule testable without a browser — a broken branch is a
// wrong island, not a flaky run — and it is what keeps the adapter honest, because `check` can only report what
// `deckResults` derives from a real envelope. One rule opens files: `deck.blank` reads the frames it is handed, because a
// pixel is not a value that travels through a report.
//
// When the envelope has no section for a rule, the rule fails; it does not pass. A missing report means the browser never
// answered, and "the links are fine" is not a sentence a check that did not look is allowed to say.

// The definition of every check this adapter produces. The contract check comes from the registry (B1-T2) rather than
// being written again here, so there is one spelling of its id and one title for it: the spec parse owns L0, this file
// owns L1 and L2, and `assertRegistry` makes sure the levels and the producers still agree.
//
// All eleven are required. A deck whose links were not looked at, or whose frames were not read, is not a deck that
// passed; the caller decides what a skip is worth, and a skip is never turned into a pass here.
const DECK_CONTRACT = CONTRACT_CHECKS.filter((def) => def.kind === "deck")

export const DECK_CHECKS: readonly CheckDef[] = [
  {
    id: "deck.slides",
    level: "L1",
    kind: "deck",
    title: "every visible slide is a scene the player can reach",
    run: "argv",
    required: true,
  },
  { id: "deck.notes", level: "L1", kind: "deck", title: "every slide has speaker notes", run: "argv", required: true },
  {
    id: "deck.links",
    level: "L1",
    kind: "deck",
    title: "every reference in the deck resolves",
    run: "argv",
    required: true,
  },
  {
    id: "deck.branch",
    level: "L1",
    kind: "deck",
    title: "every hotspot leads to a branch slide",
    run: "argv",
    required: true,
  },
  {
    id: "deck.assets",
    level: "L1",
    kind: "deck",
    title: "a missing asset is a named placeholder",
    run: "argv",
    required: true,
  },
  {
    id: "deck.overflow",
    level: "L2",
    kind: "deck",
    title: "no slide's text leaves its box or overlaps",
    run: "argv",
    required: true,
  },
  {
    id: "deck.contrast",
    level: "L2",
    kind: "deck",
    title: "every text pair passes WCAG AA",
    run: "argv",
    required: true,
  },
  {
    id: "deck.runtime",
    level: "L2",
    kind: "deck",
    title: "the page runs with no console error",
    run: "argv",
    required: true,
  },
  {
    id: "deck.snapshot",
    level: "L2",
    kind: "deck",
    title: "one snapshot per visible slide",
    run: "argv",
    required: true,
  },
  { id: "deck.blank", level: "L2", kind: "deck", title: "no snapshot is blank", run: "argv", required: true },
  {
    id: "deck.vlm",
    level: "L2",
    kind: "deck",
    title: "a vision model looked at the slides",
    run: "argv",
    required: true,
    // Skippable by declaration: the only vision engine HyperFrames can drive is a cloud model, and D13/D21 forbid calling
    // one for a check. The gate treats the skip as a warning, so a deck ships without a vision review and the report says
    // the review did not happen.
    skippable: true,
  },
]

// Every part of the envelope this file reads has the same shape: a verdict, three counts and a `findings` array of the
// same object — `code`, `severity`, `message`, `selector`. The parts differ in the extras (`layout` carries `samples`,
// `contrast` carries `checked`/`passed` and whether it ran at all), so the extras stay a record and the three common
// fields are read once. A finding that is not an object is dropped rather than guessed at: it cannot be reported.
interface Finding {
  readonly code: string
  readonly severity: string
  readonly message: string
  readonly selector?: string
}

interface Part {
  readonly ok: boolean
  readonly findings: readonly Finding[]
  readonly fields: Record<string, unknown>
}

function partOf(report: unknown, key: string): Part | undefined {
  const section = recordOf(recordOf(report)?.[key])
  if (section === undefined) return undefined
  const findings: Finding[] = []
  const listed = section["findings"]
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const item = recordOf(entry)
      if (item === undefined) continue
      findings.push({
        code: typeof item["code"] === "string" ? item["code"] : "unknown",
        severity: typeof item["severity"] === "string" ? item["severity"] : "error",
        message: typeof item["message"] === "string" ? item["message"] : "",
        ...(typeof item["selector"] === "string" ? { selector: item["selector"] } : {}),
      })
    }
  }
  return { ok: section["ok"] === true, findings, fields: section }
}

const numberIn = (part: Part, key: string): number | undefined => {
  const value = part.fields[key]
  return typeof value === "number" ? value : undefined
}

// The reported sample moments count as a list in the real envelope (`layout.samples` is the seconds the pass looked at),
// and a field that is a list is counted rather than rendered: the sentence wants "in 9 samples", not the seconds.
const listLengthIn = (part: Part, key: string): number | undefined => {
  const value = part.fields[key]
  return Array.isArray(value) ? value.length : undefined
}

// Where a finding is, in the reader's terms: the selector the browser matched, or the page when the finding is about the
// page itself. This is the closest the envelope comes to "which slide": the writer names every slide's section
// `#slide-<id>`, so a layout or contrast finding's selector begins with the slide it is on.
const addressOf = (finding: Finding): string => (finding.selector ? `${finding.selector}: ` : "")

const describe = (finding: Finding): string =>
  `${addressOf(finding)}${finding.message || finding.code}`

// How many findings a failed check names before it says how many more there are. A report is read once and fixed from
// one example; eighty findings in one sentence is a wall that hides the first.
const NAMED_FINDINGS = 3

function firstFew(findings: readonly Finding[]): string {
  const shown = findings.slice(0, NAMED_FINDINGS).map(describe).join("; ")
  const rest = findings.length - Math.min(findings.length, NAMED_FINDINGS)
  return rest > 0 ? `${shown}; and ${rest} more` : shown
}

const many = (count: number, one: string, plural = `${one}s`): string => `${count} ${count === 1 ? one : plural}`

// What one rule concluded. The verdict is a sentence and a word, and the result built from it carries the level, the code
// and the field each belongs in: a pass reads in `output`, a failure and a skip read in `reason`.
interface Verdict {
  readonly status: "passed" | "failed" | "skipped"
  readonly text: string
}

const passed = (text: string): Verdict => ({ status: "passed", text })
const failed = (text: string): Verdict => ({ status: "failed", text })
const skipped = (text: string): Verdict => ({ status: "skipped", text })

// What a check needs to say anything. The report and the shots are optional because a rule may not need them — and
// because a caller can hand `deckResults` a project before the browser has run, which is exactly how the pure rules are
// tested.
export interface DeckResultInput {
  readonly spec: DeckSpec
  readonly project: DeckProject
  readonly report?: unknown
  readonly shots?: readonly string[]
}

// The island's slides as values. The island's own type is `unknown[]` because it is written as JSON and read back by the
// player; a check reads the two fields the player reads, and a slide without a `sceneId` is dropped here and shows up as
// a count mismatch in `deck.slides` rather than as a crash.
interface IslandSlideView {
  readonly sceneId: string
  readonly hotspots: readonly { readonly id: string; readonly target: string }[]
}

function islandSlidesOf(island: DeckIsland): readonly IslandSlideView[] {
  const out: IslandSlideView[] = []
  for (const entry of island.slides) {
    const record = recordOf(entry)
    const sceneId = record?.["sceneId"]
    if (typeof sceneId !== "string" || !sceneId) continue
    const hotspots: { id: string; target: string }[] = []
    const listed = record["hotspots"]
    if (Array.isArray(listed)) {
      for (const spot of listed) {
        const item = recordOf(spot)
        if (item === undefined) continue
        const target = item["target"]
        if (typeof target !== "string") continue
        hotspots.push({ id: typeof item["id"] === "string" ? item["id"] : "?", target })
      }
    }
    out.push({ sceneId, hotspots })
  }
  return out
}

interface IslandSequenceView {
  readonly id: string
  readonly slides: readonly IslandSlideView[]
}

function islandSequencesOf(island: DeckIsland): readonly IslandSequenceView[] {
  const out: IslandSequenceView[] = []
  for (const entry of island.slideSequences) {
    const record = recordOf(entry)
    const id = record?.["id"]
    if (typeof id !== "string" || !id) continue
    const slides: IslandSlideView[] = []
    const listed = record["slides"]
    if (Array.isArray(listed)) slides.push(...islandSlidesOf({ slides: listed, slideSequences: [] }))
    out.push({ id, slides })
  }
  return out
}

const visibleSlides = (spec: DeckSpec): readonly Slide[] => spec.slides.filter((slide) => slide.hidden !== true)

// The sections the project wrote. A scene id is a section id in the HTML and a composition id in the player, so this set
// answers "is there a slide to seek to" for both the island and the checks.
const sceneIds = (project: DeckProject): ReadonlySet<string> => new Set(project.scenes.map((scene) => scene.id))

// The slides the island names, main line first and then every branch, which is every scene the player can reach.
function islandSceneIds(project: DeckProject): readonly string[] {
  return [
    ...islandSlidesOf(project.island).map((slide) => slide.sceneId),
    ...islandSequencesOf(project.island).flatMap((sequence) => sequence.slides.map((slide) => slide.sceneId)),
  ]
}

// The rules. Each one answers for its own id and nothing else; `deckResults` attaches the level from the definition, so a
// rule cannot declare itself L2 while the registry says L1.
function slidesVerdict(input: DeckResultInput): Verdict {
  const visible = visibleSlides(input.spec)
  const hidden = input.spec.slides.length - visible.length
  const islandMain = islandSlidesOf(input.project.island)
  const existing = sceneIds(input.project)
  const problems: string[] = []

  // The count first: a hidden slide is not a scene, so the island must carry exactly the visible main line.
  if (islandMain.length !== visible.length) {
    problems.push(
      `the island carries ${many(islandMain.length, "slide")} for ${visible.length} visible ${visible.length === 1 ? "slide" : "slides"}${hidden > 0 ? ` (${hidden} hidden)` : ""}`,
    )
  }
  // The ids next, and only when the counts agree: with different lengths a positional comparison would name a shift as a
  // wrong slide, which sends the reader to the wrong place.
  if (islandMain.length === visible.length) {
    const islandIds = islandMain.map((slide) => slide.sceneId)
    const specIds = visible.map((slide) => slide.id)
    if (islandIds.some((id, index) => id !== specIds[index])) {
      problems.push(`the island's slides are ${islandIds.join(", ")} but the visible slides are ${specIds.join(", ")}`)
    }
  }
  // And every id the island names — main line and branches — must be a section the project wrote. This is the fact the
  // player turns into a "scene not found" in its own console, so it is checked before the browser sees it.
  const missing = [...new Set(islandSceneIds(input.project))].filter((id) => !existing.has(id))
  if (missing.length > 0) problems.push(`the project has no scene for ${missing.join(", ")}`)

  if (problems.length > 0) return failed(problems.join("; "))
  return passed(
    `${many(visible.length, "slide")}, ${many(input.project.scenes.length, "scene")}${hidden > 0 ? ` (${hidden} hidden)` : ""}; every scene id in the island exists`,
  )
}

function notesVerdict(input: DeckResultInput): Verdict {
  const visible = visibleSlides(input.spec)
  const missing = visible.filter((slide) => (slide.notes ?? "").trim().length === 0).map((slide) => slide.id)
  if (missing.length > 0) {
    return failed(`${many(missing.length, "slide")} ${missing.length === 1 ? "has" : "have"} no notes: ${missing.join(", ")}`)
  }
  return passed(`${many(visible.length, "slide")} ${visible.length === 1 ? "has" : "have"} notes`)
}

// The lint codes that name a reference which does not resolve. HyperFrames resolves what a browser loads — media, audio,
// an external stylesheet — and a path that climbs out of the project, and reports each miss with the file that names it.
// The set is written out rather than matched by substring so that adding a code to the engine (or a new rule to this
// adapter) is a decision someone makes, not a silent widening.
//
// An `<a href>` is deliberately not in this set, and the reason is a fact about the engine: an anchor is never fetched, so
// the envelope has no link rule at all — its lint finds a missing `<img>` and says nothing about a dead hyperlink. A
// check that claimed to catch one would be reporting a rule the engine never ran. The links the player itself wires
// (hotspot → branch, island → scene) are covered by `deck.branch` and `deck.slides`; this rule covers the links the
// browser follows.
const REFERENCE_CODES: ReadonlySet<string> = new Set([
  "missing_local_asset",
  "missing_stylesheet_asset",
  "audio_src_not_found",
  "invalid_parent_traversal_in_asset_path",
  "placeholder_media_url",
  "media_missing_src",
])

function linksVerdict(input: DeckResultInput): Verdict {
  const lint = partOf(input.report, "lint")
  if (lint === undefined) return failed("hyperframes check printed no lint section, so the deck's references were not looked at")
  const broken = lint.findings.filter((finding) => REFERENCE_CODES.has(finding.code))
  if (broken.length > 0) return failed(`${many(broken.length, "unresolved reference")}: ${firstFew(broken)}`)
  return passed("no reference in the deck points at a file that is not there")
}

function branchVerdict(input: DeckResultInput): Verdict {
  const branches = new Map((input.spec.branches ?? []).map((branch) => [branch.id, branch]))
  const existing = sceneIds(input.project)
  const problems: string[] = []

  // A hotspot is a button on a slide; a button whose target is not one of this deck's sequences is a dead end the player
  // reports in its own console.
  const onboard = [
    ...islandSlidesOf(input.project.island),
    ...islandSequencesOf(input.project.island).flatMap((sequence) => sequence.slides),
  ]
  for (const slide of onboard) {
    for (const hotspot of slide.hotspots) {
      if (!branches.has(hotspot.target)) {
        problems.push(`hotspot "${hotspot.id}" on slide "${slide.sceneId}" names no branch ("${hotspot.target}")`)
      }
    }
  }
  // A sequence the player offers that no branch of the spec declares is a branch nobody wrote, and a branch's slide that
  // is not a scene is a button that leads to nothing.
  for (const sequence of islandSequencesOf(input.project.island)) {
    if (!branches.has(sequence.id)) problems.push(`the island offers a sequence "${sequence.id}" that is not a branch of the deck`)
    for (const slide of sequence.slides) {
      if (!existing.has(slide.sceneId)) problems.push(`branch "${sequence.id}" has no scene for slide "${slide.sceneId}"`)
    }
  }
  for (const branch of input.spec.branches ?? []) {
    for (const slide of branch.slides) {
      if (!existing.has(slide.id)) problems.push(`branch "${branch.id}" has no scene for slide "${slide.id}"`)
    }
  }

  if (problems.length > 0) return failed(problems.join("; "))
  const hotspots = onboard.reduce((total, slide) => total + slide.hotspots.length, 0)
  return passed(
    `${many(hotspots, "hotspot")} to ${many(branches.size, "branch", "branches")}, every branch slide is a scene`,
  )
}

function assetsVerdict(input: DeckResultInput): Verdict {
  const { placeholders } = input.project
  if (placeholders.length === 0) return passed("every asset slot is filled")
  // A placeholder is accepted — the slide shows a labelled box and the deck can be presented — but only when the report
  // names it. The note is built from the same list, so the one way it can be silent is an entry that names neither a
  // slide nor a path: that entry cannot be found again by a person fixing the deck, which is the definition of a silent
  // placeholder and therefore a failure and not a pass.
  const silent = placeholders.filter((slot) => !slot.slide.trim() || !slot.asset.trim())
  if (silent.length > 0) {
    return failed(
      `${many(silent.length, "placeholder")} with no slide or asset name cannot be reported: ${silent
        .map((slot) => `${slot.slide || "?"} -> ${slot.asset || "?"}`)
        .join(", ")}`,
    )
  }
  const note = placeholderNote(input.project)
  if (note === undefined) return failed(`${many(placeholders.length, "placeholder")} could not be named in the report`)
  return passed(note)
}

// The geometry half of the layout report's codes. Motion is not this check's business (`motion_*`), and neither are the
// connector and rotation codes a deck has no elements for; what remains is "something spilled out of its box", "two
// things overlap" and "something is where it cannot be seen".
const OVERFLOW_CODES: ReadonlySet<string> = new Set([
  "text_box_overflow",
  "clipped_text",
  "canvas_overflow",
  "container_overflow",
  "content_overlap",
  "escaped_container",
  "panel_out_of_canvas",
  "outside_safe_zone",
  "frame_out_of_frame",
  "canvas_content_at_edge",
  "caption_zone_collision",
  "text_occluded",
  "canvas_covered",
])

function overflowVerdict(input: DeckResultInput): Verdict {
  const layoutPart = partOf(input.report, "layout")
  if (layoutPart === undefined) return failed("hyperframes check printed no layout section, so no slide was measured")
  const found = layoutPart.findings.filter((finding) => OVERFLOW_CODES.has(finding.code))
  if (found.length > 0) return failed(`${many(found.length, "layout finding")}: ${firstFew(found)}`)
  const samples = listLengthIn(layoutPart, "samples")
  return passed(`no text left its box or overlapped${samples === undefined ? "" : ` in ${many(samples, "sample")}`}`)
}

function contrastVerdict(input: DeckResultInput): Verdict {
  const contrastPart = partOf(input.report, "contrast")
  if (contrastPart === undefined) return failed("hyperframes check printed no contrast section, so no text pair was measured")
  // The pass can be switched off in the CLI. A check that says "AA passes" when the pass never ran would be exactly the
  // silent pass this file refuses, so it is a skip with the reason instead.
  if (contrastPart.fields["enabled"] === false) return skipped("hyperframes ran without its contrast pass, so no text pair was measured")
  // The engine's own severity decides: a WCAG failure is an error, and a note about a borderline pair is a warning the
  // deck can ship with. The code list is not repeated here because `contrast_aa_failure` is the only finding this
  // section produces today and the severity is the durable half.
  const failures = contrastPart.findings.filter((finding) => finding.severity === "error")
  if (failures.length > 0) {
    return failed(`${many(failures.length, "text pair")} fail WCAG AA: ${firstFew(failures)}`)
  }
  const checked = numberIn(contrastPart, "checked")
  return passed(`${many(checked ?? 0, "text pair")} checked, all pass AA`)
}

function runtimeVerdict(input: DeckResultInput): Verdict {
  const runtimePart = partOf(input.report, "runtime")
  if (runtimePart === undefined) return failed("hyperframes check printed no runtime section, so the page was not watched")
  // An error is the browser saying the page did something it should not. The section's warnings (a media element that
  // cannot be drawn as asked, a tween with a tail) are not failures of this rule; the codes and the levels are the
  // engine's, and this rule reads the severity it set.
  const thrown = runtimePart.findings.filter((finding) => finding.severity === "error")
  if (thrown.length > 0) return failed(`${many(thrown.length, "runtime error")}: ${firstFew(thrown)}`)
  return passed("the page ran with no console error")
}

function snapshotVerdict(input: DeckResultInput): Verdict {
  const frames = (input.shots ?? []).length
  const visible = visibleSlides(input.spec).length
  if (frames !== visible) return failed(`${many(frames, "frame")} for ${many(visible, "slide")}`)
  return passed(`${many(frames, "frame")} for ${many(visible, "slide")}`)
}

// The share of one colour above which a frame is called blank. `blankFrame`'s own floor is 99.5%, which was measured on
// small frames; on this writer's 1920x1080 canvas a slide carrying a headline and a sentence is still 99.7% one colour,
// because text is a thin fraction of a full frame. Measured here: an empty slide (nothing but the accent rule the writer
// always draws) is 99.97% one colour, and a slide with a short headline is 99.7% or less, so 99.9% separates "nothing was
// rendered" from "something was" with room on both sides.
const BLANK_SHARE = 0.999

// A shot as the filesystem can open it: the adapter hands back job-relative paths, the CLI prints absolute ones, and a
// check may be handed either.
const shotPath = (project: DeckProject, shot: string): string =>
  isAbsolute(shot) ? shot : resolve(project.dir, shot)

function blankVerdict(input: DeckResultInput): Verdict {
  const shots = input.shots ?? []
  if (shots.length === 0) return failed("there is no frame to look at, so no slide's pixels were read")
  const blanked: string[] = []
  const broken: string[] = []
  const unreadable: string[] = []
  for (const shot of shots) {
    const path = shotPath(input.project, shot)
    // The frame as a person can find it: the job-relative name when it is inside the job, the path the CLI printed when
    // it is not.
    const name = insidePath(input.project.dir, path) ? relative(resolve(input.project.dir), path) || shot : path
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch (error) {
      // The snapshot step has just written these files, so a frame that cannot be opened is a broken run and not an odd
      // format: it fails, because the deck's pixels were never looked at.
      broken.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const image = readPng(bytes)
    if ("unsupported" in image) {
      // The reader refuses a PNG shape rather than guessing at it, and a shape it cannot read is not a blank frame: the
      // check did not look, so it is skipped with the reader's reason and the caller decides what that is worth.
      unreadable.push(`${name}: ${image.unsupported}`)
      continue
    }
    const verdict = blankFrame(image, { threshold: BLANK_SHARE })
    if (verdict.blank) blanked.push(`${name} is blank: ${verdict.why}`)
  }
  // A frame that is blank is a failure even when another frame could not be read: one says the deck did not draw, the
  // other says this reader could not look, and the first is the stronger fact. A frame that is missing is a failure too,
  // and both are reported together so one repair pass sees everything.
  const said = [
    ...(blanked.length > 0 ? [`${many(blanked.length, "blank frame")}: ${blanked.join("; ")}`] : []),
    ...(broken.length > 0 ? [`${many(broken.length, "frame")} could not be read: ${broken.join("; ")}`] : []),
    ...(unreadable.length > 0 ? [`${many(unreadable.length, "frame")} has a shape the reader does not know: ${unreadable.join("; ")}`] : []),
  ]
  if (blanked.length > 0 || broken.length > 0) return failed(said.join("; "))
  if (unreadable.length > 0) return skipped(unreadable.join("; "))
  return passed(`${many(shots.length, "frame")} all carry content`)
}

// The visual review a person would otherwise do. There is no model on this machine a check may call, and calling a cloud
// one for a deck check is refused by the roadmap's own rules (D13/D21): the deck never leaves the machine to be graded.
// The check stays in the registry because the answer is a decision a caller can act on, and a skip with a reason is that
// decision — not a pass, and not a missing check.
const NO_VISION_MODEL =
  "no local vision model is configured, and a cloud model is not called for a deck check (D13/D21)"

function verdictFor(id: string, input: DeckResultInput): Verdict | undefined {
  switch (id) {
    case "deck.slides":
      return slidesVerdict(input)
    case "deck.notes":
      return notesVerdict(input)
    case "deck.links":
      return linksVerdict(input)
    case "deck.branch":
      return branchVerdict(input)
    case "deck.assets":
      return assetsVerdict(input)
    case "deck.overflow":
      return overflowVerdict(input)
    case "deck.contrast":
      return contrastVerdict(input)
    case "deck.runtime":
      return runtimeVerdict(input)
    case "deck.snapshot":
      return snapshotVerdict(input)
    case "deck.blank":
      return blankVerdict(input)
    case "deck.vlm":
      return skipped(NO_VISION_MODEL)
    default:
      return undefined
  }
}

// One result per definition, in the order the caller asked. A definition this adapter has no rule for is a skip with the
// reason and never a pass: `deck.contract` is the spec parse's (L0, run: "spec"), and a caller that hands it here should
// see that the adapter did not run it rather than a green line that hides the fact.
export function deckResults(input: DeckResultInput, defs: readonly CheckDef[]): readonly CheckResult[] {
  return defs.map((def): CheckResult => {
    const verdict = def.run === "argv" ? verdictFor(def.id, input) : undefined
    if (verdict === undefined) {
      const why =
        def.run === "argv"
          ? `no rule in the deck adapter produces ${def.id}`
          : `${def.id} is produced by the spec parse (${def.level}, run: "${def.run}"), not by the deck adapter`
      return { id: def.id, level: def.level, status: "skipped", code: SKIPPED_CODE, reason: why }
    }
    if (verdict.status === "passed") {
      return { id: def.id, level: def.level, status: "passed", code: 0, output: verdict.text }
    }
    if (verdict.status === "failed") {
      return { id: def.id, level: def.level, status: "failed", code: 1, reason: verdict.text }
    }
    return { id: def.id, level: def.level, status: "skipped", code: SKIPPED_CODE, reason: verdict.text }
  })
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
