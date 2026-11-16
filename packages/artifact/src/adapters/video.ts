// The video adapter (B2-T1): a `VideoSpec` becomes a HyperFrames project, the project is rendered to a file, and the
// engine's own reports become the checks this round can answer. The runtime it shares with the deck — the precondition,
// the tool row, the one `hyperframesRun`, the envelope readers — lives in `hyperframes.ts`; this file is about a video.
//
// A video is not a deck. The deck adapter is presented and photographed and never encoded (B3), and this adapter is the
// one that encodes: `render` asks `hyperframes render` for an MP4 or WebM inside the job. The two guards are tested in
// both directions: the deck never names `render` in its argv, and this adapter refuses a `DeckSpec` in `prepare` with a
// sentence. The type parameter is the compile-time half — `Adapter<VideoSpec>` cannot be handed a deck — and
// `videoProblem` is the runtime half, for a spec that arrived through a cast.
//
// The project is self-contained. The render runs with the network unshared (B1-T5), so no script, stylesheet or font is
// fetched: the page names system fonts only, and every scene is a section in one index.html. Captions are on-screen
// text rather than a WebVTT track. A text track is a second file the player may or may not show, and the frames a
// snapshot or a later review reads would then not contain the words; on-screen text is in the pixels at every moment,
// so the render, the snapshot and a person all see the same caption.
//
// The checks are the mechanical and visual results this round can produce: the scene count, the film's duration, the
// engine's lint, the console, the snapshot count, and the QA pass of B2-T4 — the file's own frames and audio, read by
// `ffprobe` and `ffmpeg` through the same runner (`qa.ts`). A transcript and a VLM review are declared skippable and
// skipped with the reason: no local model is configured and D13/D21 refuse a cloud one, so a green line for either would
// claim a look that never happened. Silence is skippable too, for a different and stated reason: a B2 film has no
// narration, so a film without an audio track has nothing to measure.

import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { Adapter, AdapterContext, HostRunner } from "../adapter.ts"
import { SKIPPED_CODE, type CheckDef, type CheckResult } from "../checks.ts"
import { insidePath } from "../paths.ts"
import { QA_CHECK_IDS, runQa, type QaReport } from "../qa.ts"
import type { Scene, VideoSpec } from "../spec.ts"
import {
  BROWSER_GPU_ARGS,
  checkHyperframes,
  firstFew,
  freePort,
  HYPERFRAMES_ENV_NAMES,
  hyperframesCheck,
  hyperframesLint,
  hyperframesRun,
  hyperframesServe,
  hyperframesSnapshot,
  many,
  numberText,
  outputOf,
  partOf,
  tailOf,
  type HyperframesReport,
  type HyperframesServerStart,
} from "./hyperframes.ts"

// What the root composition is called. A composition root needs a `data-composition-id`, and a scene that took the name
// would be two compositions nothing could tell apart, so it is refused where the spec is read.
const ROOT_ID = "video"

// A scene id is used as `data-composition-id`, as an element id and as a key in the timeline registration, so it is held
// to what all three accept without quoting: a letter or digit, then letters, digits, ".", "_" or "-". The contract
// (spec.ts) only requires a non-empty string, because it does not know what an adapter will do with the id; this is the
// adapter's own refusal, and it is what keeps `../` and a quote out of the page.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// The file a render writes in the job, by container. The spec chooses the container and the adapter chooses the name, so
// two specs cannot pick the same output path and a job directory cannot gain a file outside it.
const OUTPUT_FILE: Record<"mp4" | "webm", string> = { mp4: "video.mp4", webm: "video.webm" }

// The engine's names for the three quality steps. `looks` is the CLI's default and `high` is its delivery step; the
// spec's middle word maps to the usual render, so an author who says "medium" gets what the engine would have done
// anyway and only a deliberate low or high moves it.
const QUALITY_FLAG: Record<"low" | "medium" | "high", string> = { low: "draft", medium: "looks", high: "high" }

// A render is the expensive step. Ten minutes is enough for a short film on this machine and still bounded: the runner
// caps at half an hour, and a render nobody is waiting for should not hold the job until that cap.
const RENDER_TIMEOUT_MS = 10 * 60_000

// `hyperframes open` hands the project to the desktop app and returns. It is bounded because a headless host may have
// nothing to hand it to, and a sentence about that is better than a run that waits forever.
const OPEN_TIMEOUT_MS = 60_000

// A value as the writer gave it, for the refusals where the value itself is the diagnosis.
const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

// One scene as the project wrote it: the id the page uses, the window it occupies, the midpoint a snapshot seeks to and
// the lines the spec said the scene has to deliver. The checks and the adapter read this rather than the HTML, so a
// scene the writer put in the page and a scene the adapter photographs cannot disagree.
export interface VideoScene {
  readonly id: string
  readonly start: number
  readonly duration: number
  readonly midpoint: number
  readonly acceptance: readonly string[]
}

export interface VideoProject {
  readonly dir: string
  readonly files: readonly string[]
  readonly scenes: readonly VideoScene[]
  readonly duration: number
  readonly audio?: string
}

// Why a path cannot be a project URL. The contract already refuses an absolute path and a ".."; this repeats the rule
// for a spec that reached the adapter through a cast, and it says what is wrong in the adapter's own words. The test is
// on the path's text, like spec.ts: a lexical rule, so a spec can be refused before a job directory exists.
function pathProblem(value: string): string | undefined {
  if (!value) return "is empty"
  if (isAbsolute(value)) return "is absolute, but a project path is relative to the job directory"
  if (value.includes("\\")) return 'uses "\\" as a separator'
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'has an empty, "." or ".." segment'
  }
  return undefined
}

// Everything that would make the written project disagree with the spec or leave the job. One function so the refusal is
// a sentence and not a partly written project: it runs before the first directory is made.
function videoProblem(spec: VideoSpec): string | undefined {
  if (spec.kind !== "video") return `it is a ${shown(spec.kind)} spec, not a video`
  if (!(spec.fps > 0) || !Number.isFinite(spec.fps)) return `fps ${shown(spec.fps)} is not a frame rate a renderer can use`
  if (spec.scenes.length === 0) return "it has no scenes, so a render would be an empty film"

  const ids = new Set<string>()
  for (const scene of spec.scenes) {
    if (!SAFE_ID.test(scene.id)) return `scene id ${shown(scene.id)} is not a safe composition id (${SAFE_ID.source})`
    if (scene.id === ROOT_ID) return `scene id ${shown(ROOT_ID)} is the root composition's own id`
    if (ids.has(scene.id)) return `scene id ${shown(scene.id)} is used twice`
    ids.add(scene.id)
    if (!(scene.duration > 0) || !Number.isFinite(scene.duration)) {
      return `scene ${shown(scene.id)}: duration ${shown(scene.duration)} is not a number of seconds greater than 0`
    }
    if (scene.asset !== undefined) {
      const problem = pathProblem(scene.asset)
      if (problem) return `scene ${shown(scene.id)}: asset ${shown(scene.asset)} ${problem}`
    }
  }
  if (spec.audio !== undefined) {
    const problem = pathProblem(spec.audio.src)
    if (problem) return `audio ${shown(spec.audio.src)} ${problem}`
    const volume = spec.audio.volume
    if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 1)) {
      return `audio volume ${shown(volume)} is not a number between 0 and 1`
    }
  }
  if (spec.output !== undefined) {
    if (spec.output.format !== "mp4" && spec.output.format !== "webm") {
      return `output format ${shown(spec.output.format)} is not mp4 or webm`
    }
    const quality = spec.output.quality
    if (quality !== undefined && !(quality in QUALITY_FLAG)) {
      return `output quality ${shown(quality)} is not low, medium or high`
    }
  }
  return undefined
}

// A file the project points at, checked against the real job. The lexical rule above refused the text; this is the same
// rule applied to the file the text now names, including a symlink inside the job that resolves out. A renderer that is
// handed a missing audio bed or a missing picture would produce a film with a hole in it, so both are a refusal here
// rather than a warning later: the spec named a file, and the file is not there.
function fileInJob(dir: string, value: string, what: string): string {
  const target = resolve(dir, value)
  if (!insidePath(dir, target)) throw new Error(`video: ${what} ${shown(value)} resolves outside the job directory`)
  let info
  try {
    info = statSync(target)
  } catch {
    throw new Error(`video: ${what} ${shown(value)} is not a file inside the job directory`)
  }
  if (!info.isFile()) throw new Error(`video: ${what} ${shown(value)} is not a file inside the job directory`)
  return target
}

// The scenes in time. A film is a sequence, so each scene starts where the previous one ended; a scene's midpoint is
// where its snapshot is taken, because the middle is the moment a cut cannot be mistaken for the frame before it.
function layout(spec: VideoSpec): readonly VideoScene[] {
  let start = 0
  return spec.scenes.map((scene: Scene) => {
    const duration = timeOf(scene.duration)
    const entry: VideoScene = {
      id: scene.id,
      start: timeOf(start),
      duration,
      midpoint: timeOf(start + duration / 2),
      acceptance: scene.acceptance ?? [],
    }
    start = timeOf(start + duration)
    return entry
  })
}

// A time with milliseconds kept and trailing zeros dropped, so the same spec always writes the same bytes.
const timeOf = (seconds: number): number => Math.round(seconds * 1000) / 1000

// Text that is safe where it lands: in a heading, in a paragraph, in an attribute. A title is the author's prose, so it
// is escaped rather than restricted; only ids are restricted, because they are addresses.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// The scale of one scene's type, from the film's own height, so a portrait film and a landscape film differ in pixels
// and not in a stylesheet a person has to edit. The minimums keep a very small canvas readable.
function styleFor(width: number, height: number): string {
  const heading = Math.max(16, Math.round(height * 0.09))
  const caption = Math.max(11, Math.round(height * 0.04))
  const padding = Math.max(20, Math.round(height * 0.13))
  return `
      :root {
        --ground: #101014;
        --ink: #f5f5f7;
        --muted: #b9b9c2;
        --accent: #7aa2ff;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: var(--ground);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
      }
      #${ROOT_ID} { position: relative; width: ${width}px; height: ${height}px; }
      .scene {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: ${Math.round(height * 0.03)}px;
        padding: ${padding}px;
      }
      .scene h2 {
        font-size: ${heading}px;
        font-weight: 650;
        letter-spacing: -0.025em;
        line-height: 1.1;
        overflow-wrap: anywhere;
      }
      .scene .asset {
        max-width: 100%;
        max-height: 55%;
        object-fit: contain;
        border-radius: ${Math.round(height * 0.03)}px;
      }
      .scene .rule { width: ${Math.round(width * 0.1)}px; height: ${Math.max(3, Math.round(height * 0.012))}px; background: var(--accent); border-radius: 3px; }
      .captions {
        position: absolute;
        left: ${padding}px;
        right: ${padding}px;
        bottom: ${Math.round(height * 0.08)}px;
        display: flex;
        flex-direction: column;
        gap: ${Math.max(2, Math.round(height * 0.008))}px;
        font-size: ${caption}px;
        line-height: 1.35;
        color: var(--ink);
        text-align: center;
        overflow-wrap: anywhere;
      }
`
}

// One scene as a section on its own track. The runtime shows the scene whose window contains the playhead, so the
// sections are the film's cuts; `data-no-timeline` is not used because each scene registers an empty timeline below,
// which is what the static guard asks for and what keeps Studio from waiting on a composition that never reports ready.
function sceneHtml(scene: VideoScene, spec: VideoSpec, index: number, source: Scene): string {
  const lines = [
    `      <section id="scene-${scene.id}" class="clip scene" data-composition-id="${scene.id}" data-start="${numberText(scene.start)}" data-duration="${numberText(scene.duration)}" data-width="${spec.size.width}" data-height="${spec.size.height}" data-track-index="${index}">`,
    '        <div class="rule"></div>',
  ]
  if (source.title !== undefined) lines.push(`        <h2>${escapeHtml(source.title)}</h2>`)
  if (source.asset !== undefined) {
    lines.push(`        <img class="asset" src="${escapeHtml(source.asset)}" alt="${escapeHtml(source.title ?? "")}" />`)
  }
  const captions = source.captions ?? []
  if (captions.length > 0) {
    lines.push(`        <div class="captions">`)
    for (const caption of captions) lines.push(`          <p>${escapeHtml(caption)}</p>`)
    lines.push("        </div>")
  }
  lines.push("      </section>")
  return lines.join("\n")
}

// The audio bed, when the spec has one. Each `<audio>` needs an id to be mixed at all (the engine's own rule), and
// `data-volume` is the gain the spec asked for, with 1 as 0 dB.
function audioHtml(spec: VideoSpec, duration: number): string {
  const audio = spec.audio
  if (audio === undefined) return ""
  const volume = audio.volume === undefined ? 1 : audio.volume
  return `      <audio id="audio-track" class="clip" src="${escapeHtml(audio.src)}" data-start="0" data-duration="${numberText(duration)}" data-track-index="100" data-volume="${numberText(volume)}" preload="auto"></audio>\n`
}

// The empty timeline registration the static guard insists on. Every composition host needs one; a cut between static
// scenes has no tween to register, and the runtime moves the playhead. The root and every scene are registered by the
// same block, so a scene cannot be a host the producer waits on for 45 seconds.
function timelineScript(ids: readonly string[]): string {
  const lines = ids.map(
    (id) => `      window.__timelines[${JSON.stringify(id)}] = { seek: function () {}, play: function () {}, pause: function () {} };`,
  )
  return `    <script>
      window.__timelines = window.__timelines || {};
${lines.join("\n")}
    </script>`
}

function htmlFor(spec: VideoSpec, scenes: readonly VideoScene[], duration: number): string {
  const sources = new Map(spec.scenes.map((scene) => [scene.id, scene]))
  const body = scenes
    .map((scene, index) => sceneHtml(scene, spec, index, sources.get(scene.id) ?? { id: scene.id, duration: scene.duration }))
    .join("\n")
  const ids = [ROOT_ID, ...scenes.map((scene) => scene.id)]
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${spec.size.width}, height=${spec.size.height}" />
    <title>${escapeHtml(spec.job)}</title>
    <style>${styleFor(spec.size.width, spec.size.height)}    </style>
  </head>
  <body>
    <div id="${ROOT_ID}" data-composition-id="${ROOT_ID}" data-root="true" data-start="0" data-duration="${numberText(duration)}" data-width="${spec.size.width}" data-height="${spec.size.height}" data-fps="${numberText(spec.fps)}">
${audioHtml(spec, duration)}${body}
    </div>
${timelineScript(ids)}
  </body>
</html>
`
}

// The project's two side files. The registry is omitted rather than pointed at a URL: a project that runs with the
// network unshared must not carry an address it would fetch a block from, and this film has no block to fetch.
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
// The audio bed and every scene asset are the things the project points at rather than writes, so the job is asked about
// them before the page exists: a path that leaves the job, or a file that is not there, is the refusal this function
// makes. `files` is relative to `dir`, the form the adapter interface (B1-T4) and the manifest (B1-T3) resolve.
export function writeVideoProject(spec: VideoSpec, jobDir: string): VideoProject {
  const problem = videoProblem(spec)
  if (problem !== undefined) throw new Error(`video: ${problem}`)

  const dir = resolve(jobDir)
  if (spec.audio !== undefined) fileInJob(dir, spec.audio.src, "audio")
  for (const scene of spec.scenes) {
    if (scene.asset !== undefined) fileInJob(dir, scene.asset, `scene ${shown(scene.id)} asset`)
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const scenes = layout(spec)
  const last = scenes[scenes.length - 1]!
  const duration = timeOf(last.start + last.duration)
  const files: ReadonlyArray<readonly [string, string]> = [
    ["index.html", htmlFor(spec, scenes, duration)],
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
    scenes,
    duration,
    ...(spec.audio !== undefined ? { audio: spec.audio.src } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The checks. A rule is a function of the spec, the project and the engine's envelope; none of them runs anything, which
// is what lets a wrong count or a broken console report be tested without a browser.

export const VIDEO_CHECKS: readonly CheckDef[] = [
  {
    id: "video.count",
    level: "L1",
    kind: "video",
    title: "every scene in the spec is a scene the project wrote",
    run: "argv",
    required: true,
  },
  {
    id: "video.duration",
    level: "L1",
    kind: "video",
    title: "the film lasts as long as its scenes",
    run: "argv",
    required: true,
  },
  {
    id: "video.lint",
    level: "L1",
    kind: "video",
    title: "the engine's lint finds no error in the composition",
    run: "argv",
    required: true,
  },
  {
    id: "video.runtime",
    level: "L2",
    kind: "video",
    title: "the page runs with no console error",
    run: "argv",
    required: true,
  },
  {
    id: "video.snapshot",
    level: "L2",
    kind: "video",
    title: "one snapshot per scene",
    run: "argv",
    required: true,
  },
  // The QA pass (B2-T4). The frames are the encoded file's, sampled by ffmpeg at the scene midpoints and on a uniform
  // grid; the judgement is in `qa.ts` and reads them with the same PNG reader the deck's blank check uses.
  {
    id: "video.black",
    level: "L2",
    kind: "video",
    title: "no run of frames goes black",
    run: "argv",
    required: true,
  },
  {
    id: "video.freeze",
    level: "L2",
    kind: "video",
    title: "no cut shows the frame before it again",
    run: "argv",
    required: true,
  },
  {
    id: "video.flash",
    level: "L2",
    kind: "video",
    title: "no frame is far brighter than both neighbours",
    run: "argv",
    required: true,
  },
  {
    id: "video.silence",
    level: "L1",
    kind: "video",
    title: "no silent stretch longer than half a second",
    run: "argv",
    required: true,
    // A B2 film has no narration, so a film with no audio track has nothing to measure; that skip is predicted rather
    // than a surprise, and the reason says so. A film with an audio bed gets the real silencedetect pass.
    skippable: true,
  },
  {
    id: "video.transcript",
    level: "L2",
    kind: "video",
    title: "a speech model transcribed the film",
    run: "argv",
    required: true,
    // Skippable by declaration, for the same reason as the deck's vision review: no local speech model is configured and
    // a cloud one may not be called for a check (D13/D21).
    skippable: true,
  },
  {
    id: "video.vlm",
    level: "L2",
    kind: "video",
    title: "a vision model looked at the film",
    run: "argv",
    required: true,
    // Skippable by declaration: the only vision engine the stack can drive is a cloud model, and D13/D21 forbid calling
    // one for a check. The gate treats the skip as a warning, so the film ships with the absence stated.
    skippable: true,
  },
]

interface Verdict {
  readonly status: "passed" | "failed" | "skipped"
  readonly text: string
}

const passed = (text: string): Verdict => ({ status: "passed", text })
const failed = (text: string): Verdict => ({ status: "failed", text })
const skipped = (text: string): Verdict => ({ status: "skipped", text })

// What a check needs to say anything. The report and the shots are optional because a rule may not need them — and
// because a caller can hand `videoResults` a project before the browser has run, which is exactly how the pure rules are
// tested.
export interface VideoResultInput {
  readonly spec: VideoSpec
  readonly project: VideoProject
  readonly report?: unknown
  readonly shots?: readonly string[]
  // The QA pass over the rendered file (B2-T4). Absent when the caller has not run one — a pure test of the project rules,
  // or a `check` that found no rendered file — and the QA ids then skip with that sentence rather than a green line.
  readonly qa?: QaReport
}

function countVerdict(input: VideoResultInput): Verdict {
  const wanted = input.spec.scenes.map((scene) => scene.id)
  const written = input.project.scenes.map((scene) => scene.id)
  if (written.length !== wanted.length) {
    return failed(`${many(written.length, "scene")} written for ${wanted.length} in the spec`)
  }
  if (written.some((id, index) => id !== wanted[index])) {
    return failed(`the project's scenes are ${written.join(", ")} but the spec's are ${wanted.join(", ")}`)
  }
  return passed(`${many(written.length, "scene")}, in the spec's order`)
}

function durationVerdict(input: VideoResultInput): Verdict {
  const scenes = input.spec.scenes.reduce((total, scene) => total + scene.duration, 0)
  const expected = timeOf(scenes)
  if (!(expected > 0) || !Number.isFinite(expected)) return failed(`the scenes add up to ${shown(expected)} s`)
  if (Math.abs(input.project.duration - expected) > 0.001) {
    return failed(`the project lasts ${numberText(input.project.duration)} s but the scenes add up to ${numberText(expected)} s`)
  }
  return passed(`${numberText(input.project.duration)} s across ${many(input.spec.scenes.length, "scene")}`)
}

function lintVerdict(input: VideoResultInput): Verdict {
  const lint = partOf(input.report, "lint")
  if (lint === undefined) return failed("hyperframes check printed no lint section, so the composition's lint was not looked at")
  const errors = lint.findings.filter((finding) => finding.severity === "error")
  if (errors.length > 0 || lint.ok === false) {
    return failed(
      errors.length > 0
        ? `${many(errors.length, "lint error")}: ${firstFew(errors)}`
        : "the engine's lint reported a failure it did not list",
    )
  }
  return passed(`no lint error${lint.findings.length > 0 ? ` (${many(lint.findings.length, "finding")})` : ""}`)
}

function runtimeVerdict(input: VideoResultInput): Verdict {
  const runtime = partOf(input.report, "runtime")
  if (runtime === undefined) return failed("hyperframes check printed no runtime section, so the page was not watched")
  const thrown = runtime.findings.filter((finding) => finding.severity === "error")
  if (thrown.length > 0) return failed(`${many(thrown.length, "runtime error")}: ${firstFew(thrown)}`)
  return passed("the page ran with no console error")
}

function snapshotVerdict(input: VideoResultInput): Verdict {
  const frames = (input.shots ?? []).length
  const scenes = input.project.scenes.length
  if (frames !== scenes) return failed(`${many(frames, "frame")} for ${many(scenes, "scene")}`)
  return passed(`${many(frames, "frame")} for ${many(scenes, "scene")}`)
}

function verdictFor(id: string, input: VideoResultInput): Verdict | undefined {
  switch (id) {
    case "video.count":
      return countVerdict(input)
    case "video.duration":
      return durationVerdict(input)
    case "video.lint":
      return lintVerdict(input)
    case "video.runtime":
      return runtimeVerdict(input)
    case "video.snapshot":
      return snapshotVerdict(input)
    default:
      return undefined
  }
}

// One result per definition, in the order the caller asked. A definition this adapter has no rule for is a skip with the
// reason and never a pass: `video.contract` is the spec parse's (L0, run: "spec"), and a caller that hands it here should
// see that the adapter did not run it rather than a green line that hides the fact. The QA ids are answered by the report
// the QA pass produced; without that report they are a skip with the reason, because a rule that never saw a file cannot
// pass one.
export function videoResults(input: VideoResultInput, defs: readonly CheckDef[]): readonly CheckResult[] {
  return defs.map((def): CheckResult => {
    if (def.run === "argv" && (QA_CHECK_IDS as readonly string[]).includes(def.id)) {
      const check = input.qa?.checks.find((entry) => entry.id === def.id)
      if (check === undefined) {
        return {
          id: def.id,
          level: def.level,
          status: "skipped",
          code: SKIPPED_CODE,
          reason: `${def.id} is produced by the QA pass, which did not run over this film`,
        }
      }
      if (check.status === "passed") return { id: def.id, level: def.level, status: "passed", code: 0, output: check.text }
      if (check.status === "failed") return { id: def.id, level: def.level, status: "failed", code: 1, reason: check.text }
      return { id: def.id, level: def.level, status: "skipped", code: SKIPPED_CODE, reason: check.text }
    }
    const verdict = def.run === "argv" ? verdictFor(def.id, input) : undefined
    if (verdict === undefined) {
      const why =
        def.run === "argv"
          ? `no rule in the video adapter produces ${def.id}`
          : `${def.id} is produced by the spec parse (${def.level}, run: "${def.run}"), not by the video adapter`
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
// The adapter.

// A path as the adapter interface wants it: relative to the job. The CLI reports its frames absolute, so they are
// rebased here; a path it reports outside the job is kept as it is rather than rewritten, because a name the checker
// cannot resolve is worth more than one this file invented.
function jobRelative(jobDir: string, path: string): string {
  const full = resolve(jobDir, path)
  if (!insidePath(jobDir, full)) return path
  return relative(resolve(jobDir), full) || "."
}

// The video adapter object. `Adapter<VideoSpec>` is the compile-time guard against a deck; the intersection repeats the
// kind so a caller that only holds this type cannot spread a `DeckSpec` into `prepare` without a cast, and the runtime
// refusal inside `writeVideoProject` catches the cast.
export interface VideoAdapter extends Adapter<VideoSpec> {
  readonly kind: "video"
  // `preview` and `lint` are not steps of the adapter interface (B1-T4), which a deck's presenter also does not have.
  // They are the two verbs B2-T1 names that a caller drives directly: a studio server and the static pass.
  preview(ctx: AdapterContext): Promise<HyperframesServerStart>
  lint(ctx: AdapterContext): Promise<HyperframesReport>
}

export function videoAdapter(): VideoAdapter {
  let runner: HostRunner | undefined
  let spec: VideoSpec | undefined
  let project: VideoProject | undefined
  let shots: readonly string[] = []

  const built = (): VideoProject => {
    if (project === undefined) {
      throw new Error("video: the adapter ran a step before prepare, so there is no project to work on")
    }
    return project
  }

  const asked = (): VideoSpec => {
    if (spec === undefined) throw new Error("video: the adapter ran check before prepare, so there is no spec to check")
    return spec
  }

  return {
    kind: "video",
    name: "hyperframes",
    version: "0.1.0",
    // The engine makes the project and the render; the QA pass (B2-T4) measures the file it made, so the two programs that
    // read a video are declared here too — one allowlist per adapter, still written in code and still unreachable from a
    // spec. `ffprobe` names the file's shape, `ffmpeg` samples its frames and runs silencedetect.
    executables: ["hyperframes", "ffprobe", "ffmpeg"],
    // The preview server is the one call that needs the host network; a render, a snapshot and a check leave it out and
    // stay wrapped. The declaration is a permission, not a default: each run asks for it or does not.
    network: true,
    env: HYPERFRAMES_ENV_NAMES,

    // The engine is asked before anything is written. A machine without HyperFrames gets the install sentence from
    // `checkHyperframes` as a throw with no job directory touched, which is the difference between a job that failed and
    // a job that left half a film behind. The notes name the version, and a render that will be asked for a container
    // the engine does not know is refused by `writeVideoProject` before the page exists.
    async prepare(input, ctx) {
      runner = ctx.run
      const engine = await checkHyperframes(ctx.run, "a video")
      if (!engine.ok) throw new Error(engine.reason ?? "HyperFrames is not usable, so a video could not be made")
      spec = input
      project = writeVideoProject(input, ctx.jobDir)
      const notes = [`HyperFrames ${engine.version ?? "an unknown version"} made this video`]
      for (const note of notes) ctx.log(note)
      return { notes }
    },

    // One encode, with the spec's frame rate, container and quality. The size is the composition's root
    // (`data-width`/`data-height`), which the encoder reads from the page, so the file is the size the spec asked for
    // without a preset the CLI would have to recognise. `--no-browser-gpu` is deliberate: a render wants pixels, and
    // the deck's determinism argument applies to them — the same composition should encode the same frames on every
    // machine, and this host's hardware path aborts the headless shell. The output name is the adapter's and stays
    // inside the job.
    async render(ctx) {
      const current = built()
      const askedFor = asked()
      const format = askedFor.output?.format ?? "mp4"
      const file = OUTPUT_FILE[format]
      const args = [
        "render",
        current.dir,
        "-o",
        file,
        "--fps",
        numberText(askedFor.fps),
        "--format",
        format,
        ...BROWSER_GPU_ARGS,
      ]
      const quality = askedFor.output?.quality
      if (quality !== undefined) args.push("--quality", QUALITY_FLAG[quality])

      const result = await hyperframesRun(ctx.run, args, { jobDir: ctx.jobDir, timeoutMs: RENDER_TIMEOUT_MS })
      if (result.cancelled) throw new Error("video: the render was cancelled")
      if (!result.passed) {
        const said = tailOf(outputOf(result)) || `hyperframes render exited ${result.code} with no output`
        throw new Error(`video: hyperframes render failed: ${said}`)
      }
      const path = join(current.dir, file)
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        size = 0
      }
      if (size === 0) {
        throw new Error(`video: hyperframes render reported success but wrote no ${file} (${tailOf(outputOf(result))})`)
      }
      return { outputs: [file] }
    },

    // One frame per scene, at the scene's own midpoint, with the CLI's end-of-timeline frame turned off so the count is
    // the film's and not one more. The frames are the project's scenes in time, so a scene is photographed exactly when
    // it is the only thing on screen.
    async snapshot(ctx) {
      const current = built()
      const taken = await hyperframesSnapshot(ctx.run, ctx.jobDir, {
        at: current.scenes.map((scene) => scene.midpoint),
        end: false,
      })
      if (taken.shots.length !== current.scenes.length) {
        ctx.log(`video snapshot: ${taken.shots.length} frames for ${current.scenes.length} scenes`)
        if (taken.output.trim()) ctx.log(tailOf(taken.output))
      }
      shots = taken.shots.map((path) => jobRelative(ctx.jobDir, path))
      return {
        shots: shots.map((path, index) => ({ path, label: current.scenes[index]?.id ?? `frame ${index + 1}` })),
      }
    },

    // One `hyperframes check` for lint, runtime and the page's own report, because a second browser session would answer
    // about a page that is not the one the first looked at. `network` stays unset: the check reads a local file.
    //
    // The QA pass then reads the encoded file, when one is in the job. It is part of `check` rather than a verb of its own
    // because a film is checked as a file: the six QA ids are registry checks like the rest, and a caller that asked for
    // them expects the adapter it asked to answer. Before a render the file is not there and the pass says so, one sentence
    // for every QA id, without starting ffprobe or ffmpeg.
    async check(ctx, defs) {
      const current = built()
      const result = await hyperframesCheck(ctx.run, ctx.jobDir)
      if (!result.ok) {
        const said = result.refused ?? (tailOf(result.output) || "exited with no output")
        ctx.log(`hyperframes check: ${said}`)
      }
      const currentSpec = asked()
      const format = currentSpec.output?.format ?? "mp4"
      // Only a caller that asked for a QA id pays for the QA pass: a check of the project alone stays as cheap as it was.
      const wanted = defs.some((def) => (QA_CHECK_IDS as readonly string[]).includes(def.id))
      const qa = wanted
        ? await runQa(ctx.run, {
            jobDir: ctx.jobDir,
            scenes: current.scenes.map((scene) => ({ id: scene.id, start: scene.start, duration: scene.duration })),
            file: OUTPUT_FILE[format],
          })
        : undefined
      return videoResults(
        { spec: currentSpec, project: current, report: result.report, shots, ...(qa !== undefined ? { qa } : {}) },
        defs,
      )
    },

    // The studio server a person edits in. Preview and present are the same shape: a local HTTP server that holds the
    // runner until the caller cancels, so the start is bounded and the answer says whether the port came up.
    //
    // `--no-browser-gpu` matches the rest of the adapter: this host's hardware path aborts the headless shell, and a
    // studio that starts is worth more than a studio that tries the faster path and dies.
    async preview(ctx) {
      const current = built()
      const port = await freePort("video")
      const args = [
        "preview",
        current.dir,
        "--no-open",
        // Non-interactive shells make the CLI daemonize the studio; `--foreground` keeps the process the runner owns,
        // so `cancel()` is what stops the server instead of a detached process outliving the job.
        "--foreground",
        "--force-new",
        "--port",
        String(port),
        ...BROWSER_GPU_ARGS,
      ]
      return hyperframesServe(
        ctx.run,
        () => hyperframesRun(ctx.run, args, { jobDir: ctx.jobDir, network: true }),
        port,
        "hyperframes preview",
      )
    },

    // The static pass on its own, without a browser. `check` embeds the same lint section and the adapter's check reads
    // it there; this is the verb by itself for a caller that wants the findings before a render.
    async lint(ctx) {
      built()
      return hyperframesLint(ctx.run, ctx.jobDir)
    },

    // The human's door (L3): the project in the Studio/desktop app. A video's editor is the browser/desktop surface
    // HyperFrames ships, and `hyperframes open` is the verb that hands the project to it. The deck's `present` is not
    // this adapter's verb: a film is not presented slide by slide.
    async openEditor(ctx) {
      const current = built()
      const result = await hyperframesRun(ctx.run, ["open", current.dir], {
        jobDir: ctx.jobDir,
        timeoutMs: OPEN_TIMEOUT_MS,
      })
      if (!result.passed) {
        const said = tailOf(outputOf(result)) || `hyperframes open exited ${result.code} with no output`
        throw new Error(
          `video: hyperframes open could not open the studio: ${said}. It needs a desktop session with the HyperFrames app installed`,
        )
      }
      const said = outputOf(result)
      // The CLI answers zero when it can only point at the download page. That is not an editor opening, so it is
      // reported as the thing the verb needs rather than logged as a success.
      if (/isn'?t installed|is not installed|Download it:/i.test(said)) {
        throw new Error(`video: hyperframes open needs the HyperFrames desktop app: ${tailOf(said)}`)
      }
      ctx.log(said || "hyperframes open handed the project to the studio")
    },

    // The way out of a render or a server that is holding the runner. A cancelled run is not a failed one; the runner
    // reports it as a value, and the report can say the user closed the window.
    cancel() {
      runner?.cancel()
    },
  }
}
