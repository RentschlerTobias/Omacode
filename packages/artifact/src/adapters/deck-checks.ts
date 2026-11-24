// The deck's checks (B3-T4).
//
// A deck is worth presenting when the five things it can know are true of it — the slides the island names are the
// slides the spec has, a note hangs off each one, a hotspot lands on a branch, every reference resolves, and a missing
// picture is a labelled box rather than a gap — and when the four things only a browser can see are true too: nothing
// overflows, the text passes contrast, the page throws nothing, and every frame has something on it. The first group is
// a mapping over the spec and the project; the second is read out of one `hyperframes check` envelope. One more is about
// the presenter itself (deck.present): what a probe saw stepping through `hyperframes present` in a real browser, because
// a page that renders well frame by frame can still present every slide at once.
//
// The mapping is a function of values, not of the engine: `deckResults` is given the spec, the project, the report and
// the snapshot paths, and says what follows. That makes a rule testable without a browser — a broken branch is a wrong
// island, not a flaky run — and it is what keeps the adapter honest, because `check` can only report what `deckResults`
// derives from a real envelope. One rule opens files: `deck.blank` reads the frames it is handed, since a pixel is not
// a value that travels through a report.
//
// When the envelope has no section for a rule, it fails; it does not pass. A missing report means the browser never
// answered, and "the links are fine" is not a sentence a check that did not look is allowed to say.
//
// This file owns the definitions and their rules and nothing that writes or runs anything: the project the rules are
// about comes from `deck-project.ts`, the envelope from `deck-run.ts`, and both are imported, never the reverse.

import { readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

import { CONTRACT_CHECKS, SKIPPED_CODE, type CheckDef, type CheckResult } from "../checks.ts"
import { insidePath } from "../paths.ts"
import { blankFrame, readPng } from "../png.ts"
import type { DeckSpec, Slide } from "../spec.ts"
import { firstFew, listLengthIn, many, NAMED_FINDINGS, numberIn, partOf, recordOf } from "./hyperframes.ts"
import { placeholderNote, type DeckIsland, type DeckProject } from "./deck-project.ts"

// The definition of every check this adapter produces. The contract check comes from the registry (B1-T2) rather than
// being written again here, so there is one spelling of its id and one title for it: the spec parse owns L0, this file
// owns L1 and L2, and `assertRegistry` makes sure the levels and the producers still agree.
//
// All twelve are required. A deck whose links were not looked at, or whose frames were not read, is not a deck that
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
    id: "deck.present",
    level: "L2",
    kind: "deck",
    title: "the presenter shows one slide at a time and steps through all of them",
    run: "argv",
    required: true,
    // Skippable by declaration: it needs a Chromium where the plugin runs, and the site adapter's browser checks are
    // declared the same way. A deck that was never opened in a presenter is reported as such, never as passed.
    skippable: true,
  },
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

// Every part of the envelope this file reads has the same shape and is read by `partOf` in the runtime module. The
// findings this file adds are the ones its own rules recognise, and a finding it cannot read is dropped there rather
// than guessed at here.

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
  // What deck-probe.mjs saw in the live presenter, or why it could not look: `presentSkip` when no browser is here (a
  // skip), `presentProblem` when the probe broke (a failure).
  readonly present?: DeckPresentReport
  readonly presentSkip?: string
  readonly presentProblem?: string
}

// The presenter probe's report (deck-probe.mjs), as the rule reads it.
export interface DeckPresentStep {
  readonly expected: string
  readonly stop: number
  readonly visible: readonly string[]
  readonly titleOpacity: number | null
}

export interface DeckPresentReport {
  readonly url?: string
  readonly errors: readonly string[]
  readonly scenes: number
  readonly steps: readonly DeckPresentStep[]
  readonly shots: readonly string[]
  readonly problem?: string
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

// The deck as the person presenting sees it (2026-11-24): every check above passed on a deck whose presenter drew all
// slides on top of each other, because they read renders and the island, not the slideshow. This rule reads what the
// probe saw while stepping through the live presenter: no console error, scenes reported, exactly the expected slide on
// stage at every rest point, and its title shown.
function presentVerdict(input: DeckResultInput): Verdict {
  if (input.presentSkip !== undefined) return skipped(input.presentSkip)
  if (input.presentProblem !== undefined) return failed(`the presenter probe could not look: ${input.presentProblem}`)
  const report = input.present
  if (report === undefined) return failed("the presenter probe wrote no report, so nobody looked at the presenter")
  const said: string[] = []
  if (report.problem !== undefined) said.push(report.problem)
  if (report.errors.length > 0) {
    said.push(`${many(report.errors.length, "console error")}: ${report.errors.slice(0, NAMED_FINDINGS).join("; ")}`)
  }
  const expected = visibleSlides(input.spec).length
  const slides = new Set(report.steps.map((step) => step.expected)).size
  if (slides !== expected) said.push(`the presenter stepped through ${many(slides, "slide")}, the deck has ${expected}`)
  for (const step of report.steps) {
    const where = `at ${step.expected}${step.stop > 0 ? ` (step ${step.stop + 1})` : ""}`
    if (step.visible.length !== 1) {
      said.push(`${many(step.visible.length, "slide")} on stage ${where}${step.visible.length ? `: ${step.visible.join(", ")}` : ""}`)
    } else if (step.visible[0] !== step.expected) {
      said.push(`${step.visible[0]} was on stage ${where}`)
    } else if (step.titleOpacity !== null && step.titleOpacity < 0.99) {
      said.push(`the title is not shown ${where} (opacity ${step.titleOpacity.toFixed(2)})`)
    }
  }
  if (said.length > 0) return failed(said.slice(0, NAMED_FINDINGS + 2).join("; "))
  return passed(`${many(slides, "slide")} in ${many(report.steps.length, "step")}, one slide on stage at each, no console error`)
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
    case "deck.present":
      return presentVerdict(input)
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
