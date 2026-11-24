// The slideshow project (B3-T2), which is the deck's artifact on disk.
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
//
// This is the project layer of the deck adapter, and it imports none of its siblings: `deck-run.ts` and
// `deck-checks.ts` import from here and never the other way round. The two small helpers they share (`shown`,
// `numberText`) are exported for that reason, so a bad value is named in a run's sentence the same way the writer names
// it in a refusal.

import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import { insidePath } from "../paths.ts"
import type { DeckSpec, Slide } from "../spec.ts"


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
  // The scene's window, written out although the player could look it up by `sceneId`: the lookup waits for the scene
  // list the runtime posts, and a slideshow that initialised first resolved no slide at all (2026-11-24).
  readonly startTime: number
  readonly endTime: number
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
export const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

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
  // The engine's runtime script (`hyperframesRuntime()` in hyperframes.ts). It is copied into the project and loaded by
  // the page, because `hyperframes present` serves the page as written and its player adds no runtime to a deck whose
  // scenes are inline: without it every slide is on stage at once. Tests that only read the island leave it out.
  readonly runtime?: string
}

// The name the runtime copy has in the project.
export const DECK_RUNTIME = "hyperframe.runtime.iife.js"

// What the writer last wrote, so a page changed by hand since (in HyperFrames Studio, or in an editor) is never
// overwritten without a word. The page is generated from the spec, so a rebuild would silently throw such a change away;
// instead the writer compares the page on disk with the hash it recorded and stops when they differ (2026-11-24).
export const DECK_STAMP = ".deck-written.json"

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

// The root this writer gives every page; a page with it and no stamp was written by this adapter before stamps existed.
const ROOT_MARK = `data-composition-id="${MAIN_COMPOSITION}" data-root="true"`

export const HAND_EDITED =
  "index.html was changed by hand since the last build (for example in HyperFrames Studio), so building again would throw those changes away. Ask the user what they want: to keep the changes, leave the deck as it is or carry them into the spec (text, order, notes) yourself; to drop them, delete index.html and build again."

// Why the page on disk may not be replaced, or undefined when it may: there is none, it is what this writer last wrote,
// or it predates stamps and carries this writer's root.
export function handEditProblem(dir: string): string | undefined {
  const page = join(dir, "index.html")
  if (!existsSync(page)) return undefined
  const text = readFileSync(page, "utf8")
  let recorded: unknown
  try {
    recorded = (JSON.parse(readFileSync(join(dir, DECK_STAMP), "utf8")) as Record<string, unknown>)["index.html"]
  } catch {
    recorded = undefined
  }
  if (typeof recorded === "string") return recorded === sha256(text) ? undefined : HAND_EDITED
  return text.includes(ROOT_MARK) ? undefined : "index.html is there but was not written by the deck adapter; move it away or delete it, then build again."
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
export const numberText = (value: number): string => String(timeOf(value))

// The times a slide rests at while its reveals uncover. A reveal `k` is the body's line `k` (0-based), shown one step
// after the line before it. The player enters a slide with fragments at the first one and steps through the rest, so
// n reveals need n + 1 stops: the first shows the slide without them, and stop j + 1 uncovers the j-th reveal in sorted
// order. The window is cut into n + 1 equal steps and each stop sits in the middle of its step, inside the slide:
// [0, 1] on a slide from 8 s rests at 9.333, 12 and 14.667. The order the author wrote is irrelevant, the player reads
// a set.
function fragmentTimes(slide: Slide, start: number): number[] {
  const reveals = [...new Set(slide.reveals ?? [])]
  if (reveals.length === 0) return []
  const step = SLIDE_SECONDS / (reveals.length + 1)
  return Array.from({ length: reveals.length + 1 }, (_, k) => timeOf(start + (k + 0.5) * step))
}

// The second at which each revealed body line appears, by line index. Lines no reveal names are there from the start.
function revealTimes(slide: Slide, start: number): ReadonlyMap<number, number> {
  const ordered = [...new Set(slide.reveals ?? [])].sort((left, right) => left - right)
  const stops = fragmentTimes(slide, start)
  return new Map(ordered.map((line, j) => [line, stops[j + 1]!]))
}

// One slide as the player reads it. `fragments` and `hotspots` are always present (the manifest is easier to read and
// the validator accepts an empty array), while `notes` appears only when the spec had them: a missing note and an empty
// note are the same to the presenter, and writing one nobody wrote would make the project say more than the spec.
function islandSlide(slide: Slide, start: number): IslandSlide {
  return {
    sceneId: slide.id,
    startTime: start,
    endTime: timeOf(start + SLIDE_SECONDS),
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
      .slide .rule { width: 96px; height: 6px; background: var(--accent); border-radius: 3px; transform-origin: left center; }
      .is-hidden { display: none; }

      /* Motion, in the presenter only (LIVE_SCRIPT sets .deck-live there). The slideshow seeks from rest point to rest
         point and never plays, so a tween on the timeline would never be seen; instead a slide that comes on stage gets
         .deck-in and its parts rise in one after the other, and a revealed line rises when its stop is reached.
         Snapshots and checks render without .deck-live and see every slide whole and still. */
      .deck-live .slide > * { opacity: 0; transform: translateY(36px); }
      .deck-live .slide > .rule { transform: scaleX(0); }
      .deck-live .slide.deck-in > * {
        opacity: 1;
        transform: none;
        transition: opacity 0.55s ease-out, transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1);
      }
      .deck-live .slide.deck-in > [data-reveal-at]:not(.deck-shown) { opacity: 0; transform: translateY(36px); }
      @media (prefers-reduced-motion: reduce) {
        .deck-live .slide > *, .deck-live .slide > .rule { opacity: 1; transform: none; transition: none !important; }
      }
`

// The presenter's script. It acts only when the page sits inside `hyperframes present` (the parent document holds the
// slideshow element), so a snapshot, a check or a render sees the static page they already know how to drive.
//
// In the presenter it first loads the engine's runtime from the project, synchronously, before the player looks for one:
// the player adds a runtime only to a deck whose scenes live in their own files, and without one every slide is on stage
// at once. Loading it only here keeps it out of the lint (which reads every local script, and the runtime's own clock
// reads are errors there) and out of the render, which brings its own.
//
// Then the motion: on every seek it finds the scene the playhead is in; a new scene gets .deck-in with its parts
// staggered, and a line whose reveal time has been reached gets .deck-shown. Nothing here is a clock: it reacts to the
// player's seeks.
const liveScript = (runtime: boolean): string => `
      (function () {
        var host = null;
        try {
          host = window.parent !== window ? window.parent.document.querySelector("hyperframes-slideshow") : null;
        } catch (err) {
          host = null;
        }
        if (!host) return;
${runtime ? `        if (!window.__player) document.write('<script src="${DECK_RUNTIME}"><\\/script>');\n` : ""}        document.documentElement.classList.add("deck-live");
        var scenes = Array.prototype.slice.call(document.querySelectorAll("section[data-composition-id]")).map(function (el) {
          var start = Number(el.getAttribute("data-start"));
          return { el: el, start: start, end: start + Number(el.getAttribute("data-duration")) };
        });
        var current = null;
        function enter(el) {
          if (current) current.classList.remove("deck-in");
          current = el;
          var step = 0;
          Array.prototype.forEach.call(el.children, function (child) {
            child.style.transitionDelay = child.hasAttribute("data-reveal-at") ? "0s" : (0.05 + 0.12 * step++).toFixed(2) + "s";
          });
          el.classList.remove("deck-in");
          void el.offsetWidth;
          el.classList.add("deck-in");
        }
        function show(time) {
          var scene = scenes.find(function (s) { return time >= s.start && time < s.end; });
          if (scene && scene.el !== current) enter(scene.el);
          Array.prototype.forEach.call(document.querySelectorAll("[data-reveal-at]"), function (el) {
            el.classList.toggle("deck-shown", time >= Number(el.getAttribute("data-reveal-at")) - 0.001);
          });
        }
        window.addEventListener("hf-seek", function (event) {
          var time = event && event.detail ? Number(event.detail.time) : NaN;
          if (Number.isFinite(time)) show(time);
        });
      })();
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
// The body as paragraphs, one per line the author wrote, so a reveal can uncover a line. A line a reveal names carries
// the second it appears at; the presenter hides it until then, everything else shows it.
function bodyLines(slide: Slide, reveals: ReadonlyMap<number, number>): string[] {
  if (slide.body === undefined) return []
  return slide.body.split("\n").map((line, index) => {
    const at = reveals.get(index)
    return at === undefined ? `        <p>${escapeHtml(line)}</p>` : `        <p data-reveal-at="${numberText(at)}">${escapeHtml(line)}</p>`
  })
}

function sceneHtml(scene: Scene, track: number, faults: ReadonlyMap<string, AssetFault>): string {
  const { slide, start } = scene
  const lines = [
    `      <section id="slide-${slide.id}" class="clip slide" data-composition-id="${slide.id}" data-start="${numberText(start)}" data-duration="${SLIDE_SECONDS}" data-width="${SLIDE_WIDTH}" data-height="${SLIDE_HEIGHT}" data-track-index="${track}">`,
    '        <div class="rule"></div>',
  ]
  if (slide.title !== undefined) lines.push(`        <h2>${escapeHtml(slide.title)}</h2>`)
  lines.push(...bodyLines(slide, revealTimes(slide, start)))
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
  lines.push(...bodyLines(slide, new Map()))
  lines.push(...assetLines(slide, faults.get(slide.id)))
  lines.push("      </section>")
  return lines.join("\n")
}

function htmlFor(
  spec: DeckSpec,
  scenes: readonly Scene[],
  island: DeckIsland,
  faults: ReadonlyMap<string, AssetFault>,
  runtime: boolean,
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
    <script>${liveScript(runtime)}    </script>
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
  const edited = handEditProblem(dir)
  if (edited !== undefined) throw new Error(`deck: ${edited}`)
  const { faults, placeholders } = scanAssets(spec, dir, opts.maxAssetBytes ?? MAX_ASSET_BYTES)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const scenes = layout(spec)
  const island = islandFor(spec, scenes)
  const files: ReadonlyArray<readonly [string, string]> = [
    ["index.html", htmlFor(spec, scenes, island, faults, opts.runtime !== undefined)],
    ["hyperframes.json", PROJECT_JSON],
    ["meta.json", metaJson(spec.job)],
  ]
  for (const [name, text] of files) {
    const path = join(dir, name)
    writeFileSync(path, text, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  const stamp = join(dir, DECK_STAMP)
  writeFileSync(stamp, `${JSON.stringify({ "index.html": sha256(files[0]![1]) })}\n`, { mode: 0o600 })
  chmodSync(stamp, 0o600)
  if (opts.runtime !== undefined) {
    const path = join(dir, DECK_RUNTIME)
    copyFileSync(opts.runtime, path)
    chmodSync(path, 0o600)
  }

  return {
    dir,
    files: [...files.map(([name]) => name), ...(opts.runtime !== undefined ? [DECK_RUNTIME] : [])],
    slides: island.slides.length,
    island,
    // The scenes as the caller may hold them: ids and seconds, and no slide body. A snapshot seeks to `start`, and a
    // check asks which of these are the main line, so neither has to read the HTML or the island.
    scenes: scenes.map(({ slide, start, branch }) => ({ id: slide.id, start, branch })),
    placeholders,
  }
}
