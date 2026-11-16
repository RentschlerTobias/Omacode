// The output-quality gate (B1-T7): what "worth shipping" means once the checks have run. A check can pass and the
// artifact still be junk — a deck of untitled slides, a video scene with nothing in it, two site pages writing the same
// file, an image set where half the slots are blank — because a check only answers the question it was written to ask.
// This file reads the spec and the results and answers the one question an adapter asks before it presents or
// publishes: would you hand this to someone?
//
// It runs nothing and renders nothing. Every rule below is a function of values that already exist, so the answer is
// testable here and cannot depend on a browser, a model or a clock being present. The rules are data — one list per
// kind — so a kind cannot lose a rule by forgetting a branch in the gate, and the verdicts come out in the order they
// are written.
//
// The concept of a level belongs to checks.ts, and so does the decision "is a skip acceptable", which that file left
// to this one. An L0, L1 or L2 skip is a file that was never checked, and a file that was never checked cannot be
// called verified; an L3 skip is "nobody has looked yet", which is the normal state of a fresh artifact and says
// nothing about its quality. Making that a failing verdict would block every artifact until a person had signed it
// off, so it is a warning here: the gate would rather ship with the absence stated than pretend the absence is a
// defect.
//
// Imports are the two value files beside this one and nothing else: the gate is a decision about a spec and a set of
// results, not a program that can go looking for more.

import { evaluate, type CheckDef, type CheckResult, type Coverage } from "./checks.ts"
import type { ArtifactKind, DeckSpec, ImagesSpec, SiteSpec, Spec, VideoSpec } from "./spec.ts"

// One thing "worth shipping" means. `why` is user-facing prose in both outcomes: a reader who is told "not ok" without
// being told which slide or check is at fault has been handed a rejection, not a report.
export interface QualityVerdict {
  readonly id: string
  readonly ok: boolean
  readonly why: string
}

// The whole answer. `ship` is the conjunction of the verdicts and nothing else; `warnings` is what the gate knows but
// does not block on, so a caller can present an artifact and still say that nobody has looked at it yet.
export interface QualityReport {
  readonly ship: boolean
  readonly verdicts: readonly QualityVerdict[]
  readonly warnings: readonly string[]
}

// What the gate is handed: the spec that was asked for, the checks that were declared, what they said, and — for an
// image set, where one file per slot is the whole product — the files the render produced. `outputs` is optional
// because a caller that does not have them is a different statement from one whose render produced nothing.
export interface QualityInput {
  readonly spec: Spec
  readonly defs: readonly CheckDef[]
  readonly results: readonly CheckResult[]
  readonly outputs?: readonly string[]
}

interface Judgement {
  readonly ok: boolean
  readonly why: string
}

// A rule is an id and a judgement over one kind of spec. It receives the whole input beside the narrowed spec because
// the visual and output rules also need the registry, the results and the files that were written.
interface Rule<S extends Spec> {
  readonly id: string
  readonly judge: (spec: S, input: QualityInput) => Judgement
}

const nonEmpty = (value: string | undefined): boolean => (value ?? "").trim() !== ""

// "Worth shipping" for a deck, as numbers: a slide that needs more than half a dozen lines or a short paragraph has
// grown a second idea, and splitting it is the fix that keeps it readable without narration.
const MAX_BODY_LINES = 6
const MAX_BODY_CHARS = 400

// Counted with its noun, because "1 outputs" in a user-facing sentence is the kind of small wrongness that makes the
// rest of the report look unchecked.
const imagesOutputs = (count: number): string => `${count} output${count === 1 ? "" : "s"}`

// The check of last resort: a failed check fails an artifact no matter what the spec looks like, an invalid result
// cannot be believed, and a required check with no result is a promise nobody kept. All three name their ids here,
// because the reader's next step is to look them up.
function contractVerdict(coverage: Coverage): QualityVerdict {
  const parts: string[] = []
  if (coverage.failed.length > 0) parts.push(`failed: ${coverage.failed.map((result) => result.id).join(", ")}`)
  if (coverage.invalid.length > 0) parts.push(`invalid: ${coverage.invalid.join("; ")}`)
  if (coverage.missing.length > 0) parts.push(`missing: ${coverage.missing.join(", ")}`)
  return {
    id: "checks.contract",
    ok: coverage.ok,
    why:
      parts.length > 0
        ? parts.join("; ")
        : "every required check has a result and none of them failed",
  }
}

// A skip is an absence with a reason. Which absences can ship is the question checks.ts left open: below L3 the answer
// is none, because a visual or mechanical check that did not run means the thing it would have caught is still
// unlooked at. The L3 case is the warnings in `qualityGate`.
function skippedVerdict(coverage: Coverage, defs: readonly CheckDef[]): QualityVerdict {
  const predicted = (id: string): boolean => defs.find((def) => def.id === id)?.skippable === true
  const blocking = coverage.skipped.filter((result) => result.level !== "L3" && !predicted(result.id))
  return {
    id: "checks.skipped",
    ok: blocking.length === 0,
    why:
      blocking.length > 0
        ? blocking.map((result) => `${result.id} was skipped: ${result.reason ?? "no reason given"}`).join("; ")
        : "no L0, L1 or L2 check was skipped",
  }
}

// The reason is mandatory for a skip in checks.ts, so the fallback below is only there to keep the string total; a
// skipped result without a reason never reaches `coverage.skipped`.
function humanSkips(coverage: Coverage, defs: readonly CheckDef[]): readonly string[] {
  const predicted = (id: string): boolean => defs.find((def) => def.id === id)?.skippable === true
  return coverage.skipped
    .filter((result) => result.level === "L3" || predicted(result.id))
    .map((result) => `${result.id} was skipped: ${result.reason ?? "no reason given"}`)
}

// The visual rule a deck and a video share: at least one L2 check of that kind ran and passed. The absence of an L2
// definition is a failure rather than a quiet pass, because a deck's characteristic defects — overflow, a blank slide —
// are exactly what that level exists to catch, and a deck with no visual check has never been seen.
function visualRule<S extends Spec>(kind: ArtifactKind, what: string): Rule<S> {
  return {
    id: `${kind}.visual`,
    judge: (_spec, input) => {
      const defs = input.defs.filter((def) => def.kind === kind && def.level === "L2")
      const looked = defs.map((def) => def.id)
      if (defs.length === 0) {
        return {
          ok: false,
          why: `${what} needs a visual check: no L2 check for ${kind} is in the registry`,
        }
      }
      // A "passed" whose code is non-zero is a result `evaluate` already refuses; reading both fields here keeps this
      // verdict from calling a contradiction a pass on its own.
      const passed = defs
        .filter((def) =>
          input.results.some((result) => result.id === def.id && result.status === "passed" && result.code === 0),
        )
        .map((def) => def.id)
      if (passed.length === 0) {
        return { ok: false, why: `no visual check passed for ${kind}: looked at ${looked.join(", ")}` }
      }
      return { ok: true, why: `${passed.join(", ")} passed` }
    },
  }
}

// The mechanical rule a site uses: at least one L1 check ran and passed, so the files, counts and links were actually
// examined rather than assumed from a spec that parsed.
function mechanicalRule<S extends Spec>(kind: ArtifactKind, what: string): Rule<S> {
  return {
    id: `${kind}.mechanical`,
    judge: (_spec, input) => {
      const defs = input.defs.filter((def) => def.kind === kind && def.level === "L1")
      const looked = defs.map((def) => def.id)
      if (defs.length === 0) {
        return {
          ok: false,
          why: `${what} needs a mechanical check: no L1 check for ${kind} is in the registry`,
        }
      }
      const passed = defs
        .filter((def) =>
          input.results.some((result) => result.id === def.id && result.status === "passed" && result.code === 0),
        )
        .map((def) => def.id)
      if (passed.length === 0) {
        return { ok: false, why: `no mechanical check passed for ${kind}: looked at ${looked.join(", ")}` }
      }
      return { ok: true, why: `${passed.join(", ")} passed` }
    },
  }
}

// A slide whose content lives in `notes` cannot be read without narration: it has a title on paper and nothing on the
// screen, so the title is what a reader gets and it has to be there.
const deckReadable: Rule<DeckSpec> = {
  id: "deck.readable",
  judge: (spec) => {
    const untitled = spec.slides.filter((slide) => !nonEmpty(slide.title)).map((slide) => slide.id)
    return untitled.length === 0
      ? { ok: true, why: "every slide has a title" }
      : { ok: false, why: `slides without a title: ${untitled.join(", ")}` }
  },
}

// One idea per slide, measured the only way a spec can be measured: lines and characters. Blank lines and whitespace
// do not count, because layout padding is not an idea.
const deckOneIdea: Rule<DeckSpec> = {
  id: "deck.one-idea",
  judge: (spec) => {
    const overloaded = spec.slides.flatMap((slide) => {
      const body = slide.body ?? ""
      const lines = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
      const characters = body.trim().length
      const over: string[] = []
      if (lines.length > MAX_BODY_LINES) over.push(`${lines.length} lines`)
      if (characters > MAX_BODY_CHARS) over.push(`${characters} characters`)
      return over.length === 0 ? [] : [`${slide.id} (${over.join(", ")})`]
    })
    return overloaded.length === 0
      ? { ok: true, why: `no slide's body carries more than ${MAX_BODY_LINES} lines or ${MAX_BODY_CHARS} characters` }
      : { ok: false, why: `slides carrying more than one idea: ${overloaded.join(", ")}` }
  },
}

const DECK_RULES: readonly Rule<DeckSpec>[] = [deckReadable, deckOneIdea, visualRule<DeckSpec>("deck", "a deck")]

// A scene with no asset is a caption over nothing, and a scene with no duration is never on screen long enough to be
// seen. This is the floor B2's per-scene acceptance checks stand on; it does not depend on them existing.
const videoScenes: Rule<VideoSpec> = {
  id: "video.scenes",
  judge: (spec) => {
    const broken = spec.scenes.flatMap((scene) => {
      const problems: string[] = []
      if (!nonEmpty(scene.asset)) problems.push("no asset")
      if (!(scene.duration > 0)) problems.push("no duration greater than 0")
      return problems.length === 0 ? [] : [`scene ${scene.id} has ${problems.join(" and ")}`]
    })
    return broken.length === 0
      ? { ok: true, why: "every scene has an asset and a duration greater than 0" }
      : { ok: false, why: broken.join("; ") }
  },
}

const VIDEO_RULES: readonly Rule<VideoSpec>[] = [
  videoScenes,
  visualRule<VideoSpec>("video", "a video"),
]

// A page with no title is a page a reader cannot name, in a tab, a bookmark or a search result.
const siteTitles: Rule<SiteSpec> = {
  id: "site.titles",
  judge: (spec) => {
    const untitled = spec.pages.filter((page) => !nonEmpty(page.title)).map((page) => page.path)
    return untitled.length === 0
      ? { ok: true, why: "every page has a title" }
      : { ok: false, why: `pages without a title: ${untitled.join(", ")}` }
  },
}

// Two pages with one path are one file: whichever is written last wins and the other disappears without a word. The
// spec does not check this, so the gate does, and it names the path that was claimed twice.
const siteUnique: Rule<SiteSpec> = {
  id: "site.unique",
  judge: (spec) => {
    const counts = new Map<string, number>()
    for (const page of spec.pages) counts.set(page.path, (counts.get(page.path) ?? 0) + 1)
    const shared = [...counts].filter(([, count]) => count > 1)
    return shared.length === 0
      ? { ok: true, why: "every page has its own path" }
      : {
          ok: false,
          why: shared.map(([path, count]) => `${path} is written by ${count} pages`).join("; "),
        }
  },
}

const SITE_RULES: readonly Rule<SiteSpec>[] = [siteTitles, siteUnique, mechanicalRule<SiteSpec>("site", "a site")]

// The prompt is checked by the spec parser already. It is stated again here because a spec is not a quality statement:
// parsing says "this is a well-formed request", and this rule says "this is a request worth answering". A slot with an
// empty prompt is a generator asked to fill a frame with nothing.
const imagesPrompts: Rule<ImagesSpec> = {
  id: "images.prompts",
  judge: (spec) => {
    const bare = spec.slots.filter((slot) => !nonEmpty(slot.prompt)).map((slot) => slot.id)
    return bare.length === 0
      ? { ok: true, why: "every slot has a prompt" }
      : { ok: false, why: `slots without a prompt: ${bare.join(", ")}` }
  },
}

// One file per slot. The count is compared rather than each file being inspected, because that is all this gate can
// know without a filesystem: a missing output is a blank slot in the set, and a placeholder is still a file. Without
// `outputs` at all the caller has not told the gate what the render produced, which is its own refusal.
const imagesOutputsRule: Rule<ImagesSpec> = {
  id: "images.outputs",
  judge: (spec, input) => {
    const slots = spec.slots.length
    const noun = slots === 1 ? "slot" : "slots"
    if (input.outputs === undefined) {
      return { ok: false, why: `no outputs were given for ${slots} ${noun}` }
    }
    if (input.outputs.length !== slots) {
      return { ok: false, why: `${slots} ${noun} but ${imagesOutputs(input.outputs.length)}` }
    }
    return { ok: true, why: `${imagesOutputs(input.outputs.length)} for ${slots} ${noun}` }
  },
}

const IMAGES_RULES: readonly Rule<ImagesSpec>[] = [imagesPrompts, imagesOutputsRule]

// One rule list per kind, read in declaration order. The switch is what narrows the spec to the list that belongs to
// it; a kind added to ARTIFACT_KINDS without a case here would leave this function without an answer, which the
// compiler refuses.
function kindVerdicts(input: QualityInput): readonly QualityVerdict[] {
  const spec = input.spec
  switch (spec.kind) {
    case "deck":
      return judgeRules(DECK_RULES, spec, input)
    case "video":
      return judgeRules(VIDEO_RULES, spec, input)
    case "site":
      return judgeRules(SITE_RULES, spec, input)
    case "images":
      return judgeRules(IMAGES_RULES, spec, input)
  }
}

function judgeRules<S extends Spec>(rules: readonly Rule<S>[], spec: S, input: QualityInput): readonly QualityVerdict[] {
  return rules.map((rule) => {
    const judgement = rule.judge(spec, input)
    return { id: rule.id, ok: judgement.ok, why: judgement.why }
  })
}

// The gate. The two verdicts about the checks come first, then the kind's own rules in declaration order, so the same
// input always produces the same report, field for field: an adapter may compare two runs, and a report that reordered
// itself would make that comparison meaningless. `ship` is only true when every verdict is.
export function qualityGate(input: QualityInput): QualityReport {
  const coverage = evaluate(input.defs, input.results)
  const verdicts: readonly QualityVerdict[] = [
    contractVerdict(coverage),
    skippedVerdict(coverage, input.defs),
    ...kindVerdicts(input),
  ]
  return {
    ship: verdicts.every((verdict) => verdict.ok),
    verdicts,
    warnings: humanSkips(coverage, input.defs),
  }
}
