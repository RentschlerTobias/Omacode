// The QA pass (B2-T4): what the rendered file is, what its pixels do over time, what its audio does, and what a small
// driver may repair without touching what the film says. It is a module of measurements and judgements, not an adapter:
// the adapter hands it a rendered file and a job directory, it hands back one verdict per check, and the three programs it
// needs are the ones a video already has — HyperFrames' own snapshots for the scene frames, `ffprobe` for the file's
// shape and `ffmpeg` for frames and silence.
//
// Why ffmpeg reads the frames instead of another `hyperframes snapshot`: the QA pass is about the *encoded file* — the
// thing a viewer gets — and a snapshot re-renders the page, so it cannot see an encoder's black tail, a dropped frame or
// the bit depth the container really carries. One ffmpeg decode per sample is also cheaper than starting a browser, and
// the frames it writes are PNGs the package already reads (`png.ts`). The scene midpoint snapshots stay where they are
// (the adapter's `snapshot` step): they answer "what does this scene look like", and these frames answer "what does the
// film do over time". The task treats a black run, a freeze and a flash as temporal facts, and temporal facts need
// neighbours.
//
// The checks that cannot run here say so and are declared `skippable` in the registry: a transcript needs a local speech
// model and a VLM review needs a local vision model, and D13/D21 forbid calling a cloud one for a check. Silence is
// different — the measurement is local and real — but a B2 film legitimately has no narration and therefore no audio
// track, so "there is nothing to be silent" is a predicted skip with a reason, not a failure. A film that does carry an
// audio bed gets the real silencedetect pass.
//
// Nothing here spawns a program. `probeVideo`, `sampleFrames` and `measureSilence` ask the host runner, and every other
// function is a function of values, which is what lets the frame rules be tested on synthetic PNGs without a file.

import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import type { HostRunner } from "./adapter.ts"
import { many, numberText, outputOf, tailOf } from "./adapters/hyperframes.ts"
import { readPng, type Rgba } from "./png.ts"

// The ids this module answers for, in the order a report reads them. video.ts declares the definitions (the registry
// owns titles and levels) and routes these ids here, so the two files cannot disagree about which checks are the QA pass.
export const QA_CHECK_IDS = [
  "video.black",
  "video.freeze",
  "video.flash",
  "video.silence",
  "video.transcript",
  "video.vlm",
] as const
export type QaCheckId = (typeof QA_CHECK_IDS)[number]

// A frame is black when its mean luminance is at or below this. The writer's own ground is #101014, which is 16 in every
// channel, so a threshold of 16 would call every normal frame black. 8 leaves the ground on the "not black" side and
// still catches a frame that really is nothing but black.
const BLACK_LUMINANCE = 8

// How many consecutive black samples make a run. One dark frame can be a cut; two in a row is the film having gone black
// for a stretch, which is the fault the check exists for.
const BLACK_RUN = 2

// Two frames are the same when their mean absolute channel difference is at most this. Snapshot and encode noise is not
// zero, but it is far below one level; a changed title is far above.
const SAME_FRAME = 1

// A flash is a sample this much brighter than *both* neighbours. The absolute floor keeps a mostly dark film from calling
// a merely lighter frame a flash; the ratio keeps a bright film from doing the same. The default ground is 16/255, so a
// white frame between two normal ones clears both easily.
const FLASH_DELTA = 64
const FLASH_RATIO = 1.8

// A silent stretch shorter than this is a breath, not a gap. The value is the one handed to silencedetect, so the pass and
// the judgement cannot disagree about what they were looking for.
const SILENCE_SECONDS = 0.5
const SILENCE_DB = -50

// How many frames a QA pass samples by default. Enough that a cut has frames on both sides, small enough that a 5 s film
// costs ten short decodes. The scene midpoints are always included and share this budget.
export const MAX_QA_FRAMES = 12

// Where the frames land inside the job. A fixed name the adapter owns, like the render's output: no spec chooses it.
const FRAME_DIR = "qa"

const PROBE_TIMEOUT_MS = 30_000
const FRAME_TIMEOUT_MS = 30_000
const SILENCE_TIMEOUT_MS = 60_000

// The two absences the registry predicts rather than discovers. D13 and D21 are the rules: a check does not call a cloud
// model, and no local one is configured for either job on this machine yet.
const NO_SPEECH_MODEL =
  "no local speech model is configured, and a cloud model is not called for a video check (D13/D21)"
const NO_VISION_MODEL =
  "no local vision model is configured, and a cloud model is not called for a video check (D13/D21)"

const NO_AUDIO = "the film has no audio track, so there is no silence to find (B2 has no narration)"
const NO_FILE = "the job holds no rendered file yet, so there was nothing to probe"

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

// ---------------------------------------------------------------------------------------------------------------------
// ffprobe: one call, one value.

export interface ProbeStream {
  readonly index: number
  readonly type: string
  readonly width?: number
  readonly height?: number
  readonly fps?: number
}

// What the file is, as ffprobe describes it. `duration` is the format's, not a stream's: a container that knows its own
// length is what a QA pass can time samples against.
export interface VideoProbe {
  readonly duration: number
  readonly streams: readonly ProbeStream[]
  readonly video?: { readonly width: number; readonly height: number; readonly fps?: number }
  readonly audio: boolean
}

// "24/1" and "30000/1001" are the two forms ffprobe prints a frame rate in. A denominator of zero is refused rather than
// becoming Infinity.
function fpsOf(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined
  const [top, bottom] = text.split("/")
  const numerator = Number(top)
  const denominator = bottom === undefined ? 1 : Number(bottom)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined
  const value = numerator / denominator
  return value > 0 ? value : undefined
}

// The JSON envelope ffprobe prints, read into the four facts a video check needs. A file without a duration is not a
// probe: every temporal sample would be a guess.
export function readProbe(stdout: string): VideoProbe | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const envelope = parsed as Record<string, unknown>
  const format = typeof envelope["format"] === "object" && envelope["format"] !== null ? (envelope["format"] as Record<string, unknown>) : {}
  const duration = Number(format["duration"])
  if (!Number.isFinite(duration) || duration <= 0) return undefined

  const streams: ProbeStream[] = []
  const listed = envelope["streams"]
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const stream = entry as Record<string, unknown>
      const type = typeof stream["codec_type"] === "string" ? stream["codec_type"] : "unknown"
      const index = typeof stream["index"] === "number" ? stream["index"] : streams.length
      const width = typeof stream["width"] === "number" ? stream["width"] : undefined
      const height = typeof stream["height"] === "number" ? stream["height"] : undefined
      const fps = fpsOf(stream["r_frame_rate"])
      streams.push({
        index,
        type,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(fps !== undefined ? { fps } : {}),
      })
    }
  }

  const first = streams.find((stream) => stream.type === "video" && stream.width !== undefined && stream.height !== undefined)
  return {
    duration,
    streams,
    ...(first ? { video: { width: first.width!, height: first.height!, ...(first.fps !== undefined ? { fps: first.fps } : {}) } } : {}),
    audio: streams.some((stream) => stream.type === "audio"),
  }
}

export interface ProbeResult {
  readonly probe?: VideoProbe
  readonly reason?: string
}

// `ffprobe` on the rendered file, in the job. The arguments name the file relatively, so the runner resolves it against
// the job like every other path and the check cannot be pointed at a file outside it.
export async function probeVideo(run: HostRunner, jobDir: string, file: string): Promise<ProbeResult> {
  const result = await run.run({
    exe: "ffprobe",
    args: [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=index,codec_type,width,height,r_frame_rate",
      "-of",
      "json",
      file,
    ],
    cwd: jobDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  if (result.refused) return { reason: `ffprobe is not runnable here, so the file was not measured: ${result.refused}` }
  if (!result.passed) {
    return { reason: `ffprobe could not read ${file}: ${tailOf(outputOf(result)) || `exit ${result.code}`}` }
  }
  const probe = readProbe(result.stdout)
  return probe === undefined ? { reason: `ffprobe printed no duration for ${file}` } : { probe }
}

// ---------------------------------------------------------------------------------------------------------------------
// The frames: where to sample, what one sample is, and what the samples say.

// One frame as the rules read it: when it was taken, which scene was on screen, and the pixels.
export interface QaSample {
  readonly at: number
  readonly scene?: string
  readonly image: Rgba
}

// What the report carries about a frame: the time, the scene and the file a person can open. The pixels are not kept,
// because a report that held every frame would be a second copy of the film.
export interface QaFrameInfo {
  readonly at: number
  readonly scene?: string
  readonly path: string
}

// The scene window a sample falls in. Scenes are laid out back to back (video.ts), so the last one includes its end.
export interface SceneWindow {
  readonly id: string
  readonly start: number
  readonly duration: number
}

const sceneAt = (scenes: readonly SceneWindow[], at: number): string | undefined => {
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index]!
    const end = scene.start + scene.duration
    if (at >= scene.start && (at < end || (index === scenes.length - 1 && at <= end))) return scene.id
  }
  return undefined
}

const roundMs = (value: number): number => Math.round(value * 1000) / 1000

// Where the QA pass samples. Every scene midpoint plus a uniform grid: the midpoints are the frames a scene check already
// uses, and the grid is what gives a frame neighbours on both sides of a cut. Duplicates at the same millisecond collapse,
// and the film's frame boundary is kept out of the sample so a timestamp does not land after the last frame.
export function sampleTimes(
  duration: number,
  scenes: readonly SceneWindow[],
  max = MAX_QA_FRAMES,
): readonly { readonly at: number; readonly scene?: string }[] {
  if (!(duration > 0) || !Number.isFinite(duration)) return []
  const budget = Math.max(3, Math.min(Math.trunc(max), MAX_QA_FRAMES))
  const uniform = Math.max(2, budget - scenes.length)
  const times: number[] = []
  for (let index = 0; index < uniform; index += 1) {
    times.push(roundMs(((index + 0.5) * duration) / uniform))
  }
  for (const scene of scenes) times.push(roundMs(scene.start + scene.duration / 2))

  const unique: number[] = []
  for (const at of times.sort((a, b) => a - b)) {
    if (at < 0 || at >= duration) continue
    if (unique.length > 0 && Math.abs(unique[unique.length - 1]! - at) < 0.001) continue
    unique.push(at)
  }
  // A film with more scenes than the budget keeps the first `budget` samples in order: every scene still has a frame at
  // its midpoint when it fits, and a board too large for one pass is reported by the count rather than silently shortened.
  return unique.slice(0, budget).map((at) => {
    const scene = sceneAt(scenes, at)
    return { at, ...(scene !== undefined ? { scene } : {}) }
  })
}

// Mean luminance of one frame, on the 0-255 scale the PNG carries, sampled on the same grid the distance uses. A pixel
// grid is enough: black is black everywhere, and a flash is a whole frame, not a corner.
function gridStep(image: Rgba): number {
  return Math.max(1, Math.floor(Math.min(image.width, image.height) / 48))
}

const luminance = (image: Rgba): number => {
  const step = gridStep(image)
  let total = 0
  let count = 0
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const [r, g, b] = image.at(x, y)
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b
      count += 1
    }
  }
  return count > 0 ? total / count : 0
}

// Mean absolute channel difference between two frames on a common grid. A different size is not a small difference: it is
// a different film, so it is Infinity and never "the same".
const distance = (a: Rgba, b: Rgba): number => {
  if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY
  const step = gridStep(a)
  let total = 0
  let count = 0
  for (let y = 0; y < a.height; y += step) {
    for (let x = 0; x < a.width; x += step) {
      const [ar, ag, ab] = a.at(x, y)
      const [br, bg, bb] = b.at(x, y)
      total += Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)
      count += 3
    }
  }
  return count > 0 ? total / count : 0
}

export type FrameFault =
  | { readonly kind: "black"; readonly times: readonly number[]; readonly scenes: readonly string[] }
  | { readonly kind: "freeze"; readonly at: number; readonly scenes: readonly [string, string]; readonly times: readonly [number, number] }
  | {
      readonly kind: "flash"
      readonly at: number
      readonly scene?: string
      readonly brightness: number
      readonly brighter: number
    }

// What the sampled frames say. Three temporal rules, each of them a property of neighbouring frames rather than of one:
//
// - black: a run of samples whose mean luminance is at or below the floor;
// - freeze: two identical samples on either side of a cut. Inside one scene identical frames are expected — a title card
//   is a still — so a still is only a fault when it is the same still across a boundary the film meant to change;
// - flash: one sample far brighter than both of its neighbours.
export function judgeFrames(samples: readonly QaSample[]): readonly FrameFault[] {
  const faults: FrameFault[] = []
  if (samples.length === 0) return faults
  const lums = samples.map((sample) => luminance(sample.image))

  let run: number[] = []
  const flush = (): void => {
    if (run.length >= BLACK_RUN) {
      faults.push({
        kind: "black",
        times: run.map((index) => samples[index]!.at),
        scenes: [...new Set(run.map((index) => samples[index]!.scene).filter((id): id is string => id !== undefined))],
      })
    }
    run = []
  }
  lums.forEach((value, index) => {
    if (value <= BLACK_LUMINANCE) run.push(index)
    else flush()
  })
  flush()

  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]!
    const after = samples[index]!
    if (before.scene === undefined || after.scene === undefined || before.scene === after.scene) continue
    if (distance(before.image, after.image) <= SAME_FRAME) {
      faults.push({
        kind: "freeze",
        at: after.at,
        scenes: [before.scene, after.scene],
        times: [before.at, after.at],
      })
    }
  }

  for (let index = 1; index < samples.length - 1; index += 1) {
    const previous = lums[index - 1]!
    const current = lums[index]!
    const next = lums[index + 1]!
    const neighbours = Math.max(previous, next)
    if (current - neighbours < FLASH_DELTA || current < neighbours * FLASH_RATIO) continue
    faults.push({
      kind: "flash",
      at: samples[index]!.at,
      ...(samples[index]!.scene !== undefined ? { scene: samples[index]!.scene } : {}),
      brightness: current,
      brighter: current - neighbours,
    })
  }
  return faults
}

// ---------------------------------------------------------------------------------------------------------------------
// Silence: one silencedetect pass, and the parser for what it logs.

export interface SilenceSegment {
  readonly start: number
  readonly end: number
}

// ffmpeg's silencedetect prints its verdict as log lines, not as JSON: `silence_start: 1.2` and `silence_end: 2.4 |
// silence_duration: 1.2`. A start with no end when the file runs out is closed at the file's duration, because the last
// stretch is still silent and a parser that dropped it would under-report the one case a film usually has.
export function readSilence(text: string, duration: number): readonly SilenceSegment[] {
  const segments: SilenceSegment[] = []
  let open: number | undefined
  for (const line of text.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (start !== null) {
      open = Number(start[1]!)
      continue
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (end !== null && open !== undefined) {
      segments.push({ start: Math.max(0, open), end: Math.max(0, Number(end[1]!)) })
      open = undefined
    }
  }
  if (open !== undefined) segments.push({ start: Math.max(0, open), end: duration })
  return segments
}

export interface SilenceMeasurement {
  readonly segments: readonly SilenceSegment[]
  readonly reason?: string
}

// The silencedetect pass on the film's audio. It decodes the whole audio track to nothing, which is what makes it a
// measurement rather than a sample: silence is a stretch, and a stretch is only visible from end to end.
export async function measureSilence(
  run: HostRunner,
  jobDir: string,
  file: string,
  duration: number,
): Promise<SilenceMeasurement> {
  const result = await run.run({
    exe: "ffmpeg",
    args: ["-v", "info", "-nostdin", "-i", file, "-af", `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_SECONDS}`, "-f", "null", "-"],
    cwd: jobDir,
    timeoutMs: SILENCE_TIMEOUT_MS,
  })
  if (result.refused) {
    return { segments: [], reason: `ffmpeg is not runnable here, so the film's audio was not measured: ${result.refused}` }
  }
  if (!result.passed) {
    return { segments: [], reason: `ffmpeg could not run silencedetect on ${file}: ${tailOf(outputOf(result))}` }
  }
  return { segments: readSilence(result.stderr, duration) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Frame sampling through the runner.

export interface FrameResult {
  readonly samples: readonly QaSample[]
  readonly frames: readonly QaFrameInfo[]
  readonly reason?: string
}

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// One ffmpeg decode per requested moment, into `qa/frame-NN.png` in the job. A refusal or a failed decode means the pass
// did not look, so the caller skips rather than judging a partial film: two frames out of twelve are not a sample of the
// film, they are a sample of the two frames that worked.
export async function sampleFrames(
  run: HostRunner,
  jobDir: string,
  file: string,
  times: readonly { readonly at: number; readonly scene?: string }[],
): Promise<FrameResult> {
  if (times.length === 0) {
    return { samples: [], frames: [], reason: "the film has no moment to sample, so no frame was taken" }
  }
  const dir = join(jobDir, FRAME_DIR)
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return { samples: [], frames: [], reason: `the QA frame directory could not be made: ${why(error)}` }
  }

  const samples: QaSample[] = []
  const frames: QaFrameInfo[] = []
  for (const [index, time] of times.entries()) {
    const name = `${FRAME_DIR}/frame-${String(index + 1).padStart(2, "0")}.png`
    const result = await run.run({
      exe: "ffmpeg",
      args: ["-v", "error", "-nostdin", "-ss", numberText(time.at), "-i", file, "-frames:v", "1", "-update", "1", "-y", name],
      cwd: jobDir,
      timeoutMs: FRAME_TIMEOUT_MS,
    })
    if (result.refused) {
      return { samples: [], frames: [], reason: `ffmpeg is not runnable here, so no frame was sampled: ${result.refused}` }
    }
    if (!result.passed) {
      return {
        samples: [],
        frames: [],
        reason: `ffmpeg could not sample the frame at ${numberText(time.at)} s: ${tailOf(outputOf(result)) || `exit ${result.code}`}`,
      }
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(join(jobDir, name))
    } catch (error) {
      return { samples: [], frames: [], reason: `${name} was not written: ${why(error)}` }
    }
    const image = readPng(bytes)
    if ("unsupported" in image) {
      return { samples: [], frames: [], reason: `${name} has a shape the reader does not know: ${image.unsupported}` }
    }
    samples.push({ at: time.at, ...(time.scene !== undefined ? { scene: time.scene } : {}), image })
    frames.push({ at: time.at, ...(time.scene !== undefined ? { scene: time.scene } : {}), path: name })
  }
  return { samples, frames }
}

// ---------------------------------------------------------------------------------------------------------------------
// The verdicts.

export interface QaCheck {
  readonly id: QaCheckId
  readonly status: "passed" | "failed" | "skipped"
  readonly text: string
  readonly scenes?: readonly string[]
  readonly at?: number
}

// What the pure rules are handed. Every field is optional because every measurement can be absent, and an absent
// measurement is a skip with its reason, never a pass.
export interface QaEvidence {
  readonly file?: string
  readonly probe?: VideoProbe
  readonly probeReason?: string
  readonly samples?: readonly QaSample[]
  readonly sampleReason?: string
  readonly silence?: SilenceMeasurement
  readonly duration?: number
}

const list = (values: readonly string[]): string => values.join(", ")

interface FrameVerdicts {
  readonly "video.black": QaCheck
  readonly "video.freeze": QaCheck
  readonly "video.flash": QaCheck
}

function frameVerdicts(evidence: QaEvidence): FrameVerdicts {
  const samples = evidence.samples ?? []
  if (evidence.file === undefined) {
    const text = NO_FILE
    return {
      "video.black": { id: "video.black", status: "skipped", text },
      "video.freeze": { id: "video.freeze", status: "skipped", text },
      "video.flash": { id: "video.flash", status: "skipped", text },
    }
  }
  if (evidence.sampleReason !== undefined) {
    return {
      "video.black": { id: "video.black", status: "skipped", text: evidence.sampleReason },
      "video.freeze": { id: "video.freeze", status: "skipped", text: evidence.sampleReason },
      "video.flash": { id: "video.flash", status: "skipped", text: evidence.sampleReason },
    }
  }
  if (samples.length < 2) {
    const text = `${many(samples.length, "frame")} sampled, too few to judge a run, a cut or a flash`
    return {
      "video.black": { id: "video.black", status: "skipped", text },
      "video.freeze": { id: "video.freeze", status: "skipped", text },
      "video.flash": { id: "video.flash", status: "skipped", text },
    }
  }

  const faults = judgeFrames(samples)
  const black = faults.filter((fault): fault is Extract<FrameFault, { kind: "black" }> => fault.kind === "black")
  const freeze = faults.filter((fault): fault is Extract<FrameFault, { kind: "freeze" }> => fault.kind === "freeze")
  const flash = faults.filter((fault): fault is Extract<FrameFault, { kind: "flash" }> => fault.kind === "flash")

  // The probe's four facts in the one sentence a reader sees, so a passing frame check also says which file it read: the
  // duration the samples were spread over and, when ffprobe named the stream, its size and rate.
  const film = evidence.probe === undefined
    ? ""
    : ` of the ${numberText(evidence.probe.duration)} s file${
        evidence.probe.video === undefined
          ? ""
          : ` (${evidence.probe.video.width}×${evidence.probe.video.height}${evidence.probe.video.fps !== undefined ? `, ${Math.round(evidence.probe.video.fps)} fps` : ""})`
      }`

  const blackCheck: QaCheck =
    black.length > 0
      ? {
          id: "video.black",
          status: "failed",
          text: black
            .map((fault) => `${many(fault.times.length, "black frame")} at ${list(fault.times.map(numberText))} s`)
            .join("; "),
          scenes: black.flatMap((fault) => fault.scenes),
        }
      : {
          id: "video.black",
          status: "passed",
          text: `${many(samples.length, "frame")} sampled${film}, none ran black for ${BLACK_RUN} or more`,
        }

  const freezeCheck: QaCheck =
    freeze.length > 0
      ? {
          id: "video.freeze",
          status: "failed",
          text: freeze
            .map(
              (fault) =>
                `the cut at ${numberText(fault.at)} s shows the same frame in scenes ${fault.scenes[0]} and ${fault.scenes[1]}`,
            )
            .join("; "),
          scenes: freeze.flatMap((fault) => fault.scenes),
          at: freeze[0]!.at,
        }
      : {
          id: "video.freeze",
          status: "passed",
          text: "no cut showed the frame before it again, so nothing froze across a boundary",
        }

  const flashCheck: QaCheck =
    flash.length > 0
      ? {
          id: "video.flash",
          status: "failed",
          text: flash
            .map(
              (fault) =>
                `the frame at ${numberText(fault.at)} s is ${fault.brightness.toFixed(0)}/255 bright, ${fault.brighter.toFixed(0)} above both neighbours`,
            )
            .join("; "),
          ...(flash[0]!.scene !== undefined ? { scenes: flash.flatMap((fault) => (fault.scene !== undefined ? [fault.scene] : [])) } : {}),
          at: flash[0]!.at,
        }
      : {
          id: "video.flash",
          status: "passed",
          text: "no frame was far brighter than both of its neighbours",
        }

  return { "video.black": blackCheck, "video.freeze": freezeCheck, "video.flash": flashCheck }
}

function silenceVerdict(evidence: QaEvidence): QaCheck {
  if (evidence.file === undefined) return { id: "video.silence", status: "skipped", text: NO_FILE }
  if (evidence.probe === undefined) {
    return {
      id: "video.silence",
      status: "skipped",
      text: `ffprobe could not name the file's streams, so its audio was not measured${evidence.probeReason !== undefined ? `: ${evidence.probeReason}` : ""}`,
    }
  }
  if (!evidence.probe.audio) return { id: "video.silence", status: "skipped", text: NO_AUDIO }
  const silence = evidence.silence
  if (silence === undefined) {
    return { id: "video.silence", status: "skipped", text: "the silence pass did not run, so the audio was not measured" }
  }
  if (silence.reason !== undefined) return { id: "video.silence", status: "skipped", text: silence.reason }
  const duration = evidence.duration ?? evidence.probe.duration
  if (silence.segments.length > 0) {
    return {
      id: "video.silence",
      status: "failed",
      text: silence.segments
        .map((segment) => `${numberText(segment.start)}–${numberText(segment.end)} s`)
        .join(", "),
      at: silence.segments[0]!.start,
    }
  }
  return {
    id: "video.silence",
    status: "passed",
    text: `no silent stretch longer than ${SILENCE_SECONDS} s in ${numberText(duration)} s of audio`,
  }
}

// One verdict per id, in the registry's order. `transcript` and `vlm` never look at anything: there is no local model and
// D13/D21 refuse a cloud one, so their answer is the absence with its reason.
export function qaChecks(evidence: QaEvidence): readonly QaCheck[] {
  const frames = frameVerdicts(evidence)
  return [
    frames["video.black"],
    frames["video.freeze"],
    frames["video.flash"],
    silenceVerdict(evidence),
    { id: "video.transcript", status: "skipped", text: NO_SPEECH_MODEL },
    { id: "video.vlm", status: "skipped", text: NO_VISION_MODEL },
  ]
}

// ---------------------------------------------------------------------------------------------------------------------
// One QA pass over one rendered file.

export interface QaInput {
  readonly jobDir: string
  readonly scenes: readonly SceneWindow[]
  // Job-relative, the form the adapter's render returns.
  readonly file: string
}

export interface QaReport {
  readonly checks: readonly QaCheck[]
  // The scenes the film has, so the fix loop can refuse an `extend` that names a scene nothing in the report knows.
  readonly sceneIds: readonly string[]
  readonly probe?: VideoProbe
  readonly frames: readonly QaFrameInfo[]
  readonly passed: boolean
}

// The whole pass: probe, sample, hear, judge. A file that is not there is not an error — the adapter runs `check` before a
// render too — so every check comes back skipped with the one reason that explains all of them.
export async function runQa(run: HostRunner, input: QaInput): Promise<QaReport> {
  let present = false
  try {
    present = statSync(join(input.jobDir, input.file)).size > 0
  } catch {
    present = false
  }
  const sceneIds = input.scenes.map((scene) => scene.id)
  if (!present) return { checks: qaChecks({}), sceneIds, frames: [], passed: true }

  const probed = await probeVideo(run, input.jobDir, input.file)
  const duration = probed.probe?.duration ?? input.scenes.reduce((total, scene) => total + scene.duration, 0)
  const times = sampleTimes(duration, input.scenes)
  const sampled = await sampleFrames(run, input.jobDir, input.file, times)
  const silence =
    probed.probe?.audio === true && duration > 0
      ? await measureSilence(run, input.jobDir, input.file, duration)
      : undefined

  const checks = qaChecks({
    file: input.file,
    ...(probed.probe !== undefined ? { probe: probed.probe } : {}),
    ...(probed.reason !== undefined ? { probeReason: probed.reason } : {}),
    samples: sampled.samples,
    ...(sampled.reason !== undefined ? { sampleReason: sampled.reason } : {}),
    ...(silence !== undefined ? { silence } : {}),
    duration,
  })
  return {
    checks,
    sceneIds,
    ...(probed.probe !== undefined ? { probe: probed.probe } : {}),
    frames: sampled.frames,
    passed: checks.every((check) => check.status !== "failed"),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The fix loop. Three rounds, and only the three repairs a video's timing and levels can make without changing what the
// film says. Everything else stops the loop with a reason and is handed to a person.

// How far a safe fix may move a thing. The caps are part of the allowlist, not a hint: a proposed 10 s extension is a
// different film, and this driver is allowed to nudge a cut, not to rewrite one.
export const FIX_LIMITS = { extendMs: 500, shiftMs: 250, gain: 2 } as const

export interface ExtendFix {
  readonly op: "extend"
  readonly scene: string
  readonly ms: number
}

export interface ShiftFix {
  readonly op: "shift"
  readonly scene: string
  readonly ms: number
}

export interface GainFix {
  readonly op: "gain"
  readonly from: number
  readonly to: number
  readonly gain: number
}

export type SafeFix = ExtendFix | ShiftFix | GainFix

// The keys each operation may carry. A key outside this set is refused even when the operation is known, because a fix
// that also carries a caption is a content change with a timing change attached.
const FIX_KEYS: Readonly<Record<SafeFix["op"], readonly string[]>> = {
  extend: ["op", "scene", "ms"],
  shift: ["op", "scene", "ms"],
  gain: ["op", "from", "to", "gain"],
}

// The wording a fix may not touch. Named rather than inferred from "unknown key", so a proposal that rewrites a scene's
// text gets the sentence a person needs: no safe fix changes what the film says.
const CONTENT_KEYS = ["text", "words", "word", "title", "caption", "captions", "script", "body", "copy"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const failedCheck = (report: QaReport, id: QaCheckId): QaCheck | undefined =>
  report.checks.find((check) => check.id === id && check.status === "failed")

export interface FixVerdict {
  readonly fix?: SafeFix
  readonly reason?: string
}

// Whether one proposal is a safe fix, and why not when it is not. The order is the reader's: is it an operation at all,
// does it carry anything else, are its numbers inside the cap, and does the report it is answering actually name the
// failure it claims to repair. That last question is what keeps a valid-looking `extend` from being applied to a flash.
export function classifyFix(value: unknown, report: QaReport): FixVerdict {
  if (!isRecord(value)) return { reason: `a fix must be an object, got ${shown(value)}` }
  const op = value["op"]
  if (op !== "extend" && op !== "shift" && op !== "gain") {
    return { reason: `fix op ${shown(op)} is not in the safe allowlist (extend, shift, gain)` }
  }
  const allowed = FIX_KEYS[op]
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    if ((CONTENT_KEYS as readonly string[]).includes(key.toLowerCase())) {
      return { reason: `a fix carrying ${shown(key)} would change a scene's wording, which no safe fix may do` }
    }
    return { reason: `a fix carrying ${shown(key)} is outside the safe allowlist for ${op}` }
  }

  if (op === "gain") {
    const from = value["from"]
    const to = value["to"]
    const gain = value["gain"]
    if (typeof from !== "number" || !Number.isFinite(from) || from < 0) return { reason: `gain.from ${shown(from)} is not a second` }
    if (typeof to !== "number" || !Number.isFinite(to) || to <= from) return { reason: `gain.to ${shown(to)} is not after ${shown(from)} s` }
    if (typeof gain !== "number" || !Number.isFinite(gain) || gain <= 1) {
      return { reason: `gain ${shown(gain)} does not raise the level (more than 1, at most ${FIX_LIMITS.gain})` }
    }
    if (gain > FIX_LIMITS.gain) return { reason: `gain ${shown(gain)} is above the cap of ${FIX_LIMITS.gain}` }
    if (failedCheck(report, "video.silence") === undefined) {
      return { reason: "no video.silence failure names a quiet segment, so raising the level would not be a fix" }
    }
    return { fix: { op: "gain", from, to, gain } }
  }

  const scene = value["scene"]
  const ms = value["ms"]
  if (typeof scene !== "string" || !report.sceneIds.includes(scene)) {
    return { reason: `scene ${shown(scene)} is not one of the film's scenes (${report.sceneIds.join(", ")})` }
  }
  if (typeof ms !== "number" || !Number.isInteger(ms)) return { reason: `ms ${shown(ms)} is not a whole number of milliseconds` }
  const cap = op === "extend" ? FIX_LIMITS.extendMs : FIX_LIMITS.shiftMs
  if (ms < 1 || ms > cap) return { reason: `ms ${ms} is outside 1–${cap} ms for ${op}` }
  const evidence: QaCheckId = op === "extend" ? "video.freeze" : "video.flash"
  const failed = failedCheck(report, evidence)
  if (failed === undefined) {
    return {
      reason: `no ${evidence} failure was reported, so ${op === "extend" ? "extending" : "shifting"} ${scene} would not be a fix`,
    }
  }
  if (failed.scenes !== undefined && !failed.scenes.includes(scene)) {
    return { reason: `${evidence} did not name scene ${scene} (${failed.scenes.join(", ")}), so ${op} would not be a fix` }
  }
  return { fix: op === "extend" ? { op: "extend", scene, ms } : { op: "shift", scene, ms } }
}

// The three repairs, worded once so the report and the applied list use the same sentence.
export const fixText = (fix: SafeFix): string =>
  fix.op === "gain"
    ? `raised ${numberText(fix.from)}–${numberText(fix.to)} s by ×${fix.gain}`
    : `${fix.op === "extend" ? "extended" : "shifted"} scene ${fix.scene} by ${fix.ms} ms`

export interface FixAuthor {
  propose(report: QaReport): Promise<readonly unknown[]>
  apply(fix: SafeFix): Promise<void>
}

export interface QaRoundOutcome {
  readonly round: number
  readonly passed: boolean
  readonly failed: readonly string[]
  readonly applied: readonly SafeFix[]
  readonly refused: readonly { readonly fix: unknown; readonly reason: string }[]
}

export interface QaRoundsInput {
  readonly render: (round: number) => Promise<void>
  readonly qa: (round: number) => Promise<QaReport>
  readonly fixes?: FixAuthor
}

export interface QaRoundsResult {
  readonly rounds: readonly QaRoundOutcome[]
  readonly stopped: "passed" | "rounds" | "human"
  readonly report?: QaReport
  readonly applied: readonly SafeFix[]
  readonly refused: readonly { readonly fix: unknown; readonly reason: string }[]
  // What a person has to decide about. Empty only when the last pass passed.
  readonly needsHuman: readonly string[]
}

export const QA_ROUNDS = 3

// Render, judge, repair, and stop. The driver never holds a spec and never edits one: `render` renders, `qa` judges, and
// `apply` is the caller's own mutation of its timing or levels. The only thing this function decides is *which* proposals
// reach `apply` — the allowlist in `classifyFix` — so a caller cannot accidentally ship a "fix" that rewrote a scene.
export async function qaRounds(input: QaRoundsInput): Promise<QaRoundsResult> {
  const rounds: QaRoundOutcome[] = []
  const applied: SafeFix[] = []
  const refused: { fix: unknown; reason: string }[] = []
  let report: QaReport | undefined

  for (let round = 1; round <= QA_ROUNDS; round += 1) {
    await input.render(round)
    report = await input.qa(round)
    const failed = report.checks.filter((check) => check.status === "failed").map((check) => check.id)
    const appliedHere: SafeFix[] = []
    const refusedHere: { fix: unknown; reason: string }[] = []
    const outcome: QaRoundOutcome = { round, passed: report.passed, failed, applied: appliedHere, refused: refusedHere }
    rounds.push(outcome)

    if (report.passed) {
      return { rounds, stopped: "passed", report, applied, refused, needsHuman: [] }
    }
    if (round === QA_ROUNDS) break
    if (input.fixes === undefined) {
      return { rounds, stopped: "human", report, applied, refused, needsHuman: failureText(report) }
    }

    const proposals = await input.fixes.propose(report)
    const safe: SafeFix[] = []
    const local: { fix: unknown; reason: string }[] = []
    for (const proposal of proposals) {
      const verdict = classifyFix(proposal, report)
      if (verdict.fix !== undefined) safe.push(verdict.fix)
      else if (verdict.reason !== undefined) local.push({ fix: proposal, reason: verdict.reason })
    }
    refused.push(...local)
    refusedHere.push(...local)
    if (safe.length === 0) {
      const why =
        local.length > 0
          ? `${many(local.length, "proposed fix", "proposed fixes")} ${local.length === 1 ? "is" : "are"} not safe: ${local.map((entry) => entry.reason).join("; ")}`
          : "no fix was proposed for the failures that remain"
      return { rounds, stopped: "human", report, applied, refused, needsHuman: [...failureText(report), why] }
    }
    for (const fix of safe) {
      await input.fixes.apply(fix)
      applied.push(fix)
      appliedHere.push(fix)
    }
  }

  return {
    rounds,
    stopped: "rounds",
    ...(report !== undefined ? { report } : {}),
    applied,
    refused,
    needsHuman: report !== undefined ? [...failureText(report), `no pass cleared them in ${QA_ROUNDS} rounds`] : [],
  }
}

// What a failed report says, one line per failed check, for the person the loop hands the film to.
function failureText(report: QaReport): readonly string[] {
  return report.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.id}: ${check.text}`)
}
