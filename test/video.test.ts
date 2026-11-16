// The video spec (B2-T2) and its HyperFrames adapter (B2-T1). The spec tests are pure: a version-2 video parses with its
// engine, audio bed, output target and per-scene acceptance, and each way of getting a field wrong fails at the address
// the reader has to fix. The adapter tests split the same way as the deck's: argv and project shapes are checked against
// a fake runner, and the engine itself — render, snapshot, check, lint, preview — is reached through the real host
// runner, because the wiring between a composition and a rendered file is not something a fake can vouch for.
//
// The QA pass (B2-T4) is tested without a browser where it can be: the frame rules on synthetic PNGs, the two model skips
// on a parsed ffprobe envelope, and the fix loop on a stub. One end-to-end run then renders the 5 s demo and asks the
// adapter for every check, so the report a person reads is exercised once against a real file.
//
// A real 5 s render is the slow test. The demo is 640x360, two scenes, draft quality and no audio: small enough that a
// host limitation is worth skipping rather than waiting out, and real enough that `ffprobe` measures an actual file.

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test, type TestContext } from "node:test"

import {
  VIDEO_CHECKS,
  videoAdapter,
  videoResults,
  writeVideoProject,
} from "../packages/artifact/src/adapters/video.ts"
import {
  HYPERFRAMES_ENV_NAMES,
  BROWSER_GPU_ARGS,
  hyperframesLint,
  hyperframesRun,
} from "../packages/artifact/src/adapters/hyperframes.ts"
import {
  assertAdapter,
  type AdapterContext,
  type HostRunInput,
  type HostRunResult,
  type HostRunner,
} from "../packages/artifact/src/adapter.ts"
import { assertRegistry, evaluate, type CheckResult } from "../packages/artifact/src/checks.ts"
import {
  QA_CHECK_IDS,
  QA_ROUNDS,
  classifyFix,
  judgeFrames,
  qaChecks,
  qaRounds,
  readProbe,
  readSilence,
  sampleTimes,
  type QaCheck,
  type QaReport,
  type QaSample,
  type SafeFix,
} from "../packages/artifact/src/qa.ts"
import { createHostRunner, hostRunnerFor } from "../packages/artifact/src/runner.ts"
import { parseSpec, specVersionOf, SPEC_VERSIONS, type DeckSpec, type VideoSpec } from "../packages/artifact/src/spec.ts"
import { frame } from "./harness.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures and fakes.

const passed = (stdout: string, stderr = ""): HostRunResult => ({
  passed: true,
  code: 0,
  stdout,
  stderr,
  timedOut: false,
  truncated: false,
})

const failed = (code: number, stderr = "", stdout = ""): HostRunResult => ({
  passed: false,
  code,
  stdout,
  stderr,
  timedOut: false,
  truncated: false,
})

interface FakeRunner extends HostRunner {
  readonly calls: readonly HostRunInput[]
}

// A runner that answers from a list and remembers what it was asked. The last answer repeats, so a test that does not
// care about the version probe still exercises it; the calls list is how a test says which question came first.
const fakeRunner = (...answers: readonly HostRunResult[]): FakeRunner => {
  const calls: HostRunInput[] = []
  return {
    calls,
    async run(input: HostRunInput): Promise<HostRunResult> {
      calls.push(input)
      const answer = answers[calls.length - 1] ?? answers[answers.length - 1]
      if (!answer) throw new Error(`unexpected run ${JSON.stringify(input)}`)
      return answer
    },
    cancel(): void {},
  }
}

// A version 2 video that uses every field B2-T2 added. It is the object the parser is asked about, not a spec that was
// already narrowed, so a field the contract forgot to accept is a failure here rather than a cast that hides it.
const video = (): Record<string, unknown> => ({
  kind: "video",
  version: 2,
  job: "job-1",
  brief: "a video about the release",
  engine: "hyperframes",
  fps: 24,
  size: { width: 640, height: 360 },
  audio: { src: "audio/theme.mp3", volume: 0.6 },
  output: { format: "mp4", quality: "high" },
  scenes: [
    {
      id: "opening",
      title: "Opening",
      duration: 2.5,
      captions: ["the release", "what it changes"],
      acceptance: ["the title is readable for the whole scene"],
    },
    { id: "closing", title: "Closing", duration: 2.5, acceptance: ["the URL is on screen"] },
  ],
})

const parsedVideo = (value: unknown): VideoSpec => {
  const parsed = parseSpec("video", value)
  assert.ok(parsed.spec, `the video fixture must parse: ${parsed.errors.join("; ")}`)
  return parsed.spec as VideoSpec
}

// The demo the real render uses: five seconds, two scenes, no audio, draft quality. A scene has no asset because a
// title is a scene; the quality gate can ask for more, but the adapter must render what the spec says.
const demo = (): VideoSpec =>
  parsedVideo({
    kind: "video",
    version: 2,
    job: "demo",
    brief: "a five second demo",
    engine: "hyperframes",
    fps: 24,
    size: { width: 640, height: 360 },
    output: { format: "mp4", quality: "low" },
    scenes: [
      {
        id: "one",
        title: "First scene",
        duration: 2.5,
        captions: ["a caption"],
        acceptance: ["the title is readable"],
      },
      { id: "two", title: "Second scene", duration: 2.5, acceptance: ["the frame changes at 2.5 s"] },
    ],
  })

// A deck spec, parsed rather than hand-shaped, so the deck-render guard is tested against a spec the package accepts.
const deckSpec = (): DeckSpec => {
  const parsed = parseSpec("deck", {
    kind: "deck",
    version: 2,
    job: "job-1",
    brief: "a deck about the release",
    slides: [{ id: "s1", title: "What shipped" }, { id: "s2" }],
  })
  assert.ok(parsed.spec, `the deck fixture must parse: ${parsed.errors.join("; ")}`)
  return parsed.spec as DeckSpec
}

const jobFor = (t: TestContext): string => {
  const root = mkdtempSync(join(tmpdir(), "mm-video-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const job = join(root, "job")
  mkdirSync(job)
  return job
}

const harnessFor = (jobDir: string, run: HostRunner): { readonly ctx: AdapterContext; readonly logs: string[] } => {
  const logs: string[] = []
  const ctx: AdapterContext = { jobDir, specPath: join(jobDir, "video.json"), run, log: (line) => logs.push(line) }
  return { ctx, logs }
}

// The two skips this file is allowed to make: a missing binary or bubblewrap, and a browser that could not start because
// the host's sandbox blocks it. A real defect in the adapter must fail rather than hide behind either sentence.
const hostLimitation = (reason: string | undefined): boolean =>
  /was not found in|is not runnable here|EACCES|No usable sandbox/.test(reason ?? "")

// ---------------------------------------------------------------------------------------------------------------------
// B2-T2: the video spec.

test("a version 2 video keeps its engine, audio, output and per-scene acceptance", () => {
  assert.equal(SPEC_VERSIONS.video, 2)
  assert.equal(specVersionOf("video"), 2)

  const spec = parsedVideo(video())
  const value = video()
  assert.deepEqual(spec, value)
  assert.equal(spec.engine, "hyperframes")
  assert.deepEqual(spec.audio, { src: "audio/theme.mp3", volume: 0.6 })
  assert.deepEqual(spec.output, { format: "mp4", quality: "high" })
  assert.deepEqual(spec.scenes[0]?.acceptance, ["the title is readable for the whole scene"])
  // The fields the contract already had are still there and unchanged.
  assert.equal(spec.fps, 24)
  assert.deepEqual(spec.size, { width: 640, height: 360 })
  assert.deepEqual(spec.scenes[0]?.captions, ["the release", "what it changes"])
})

test("a version 1 video is refused by the number this contract now has", () => {
  const parsed = parseSpec("video", { ...video(), version: 1 })
  assert.equal(parsed.spec, undefined)
  assert.deepEqual(parsed.errors, ["version: a video spec is version 2, got 1"])
})

test("an audio path outside the job, a negative volume, an unknown engine and a gif output each fail at their path", () => {
  const outside = parseSpec("video", { ...video(), audio: { src: "/etc/theme.mp3", volume: 0.5 } })
  assert.equal(outside.spec, undefined)
  assert.deepEqual(outside.errors, ['audio.src: a path must be relative to the job directory, got "/etc/theme.mp3"'])

  const climbing = parseSpec("video", { ...video(), audio: { src: "audio/../../theme.mp3", volume: 0.5 } })
  assert.equal(climbing.spec, undefined)
  assert.deepEqual(climbing.errors, [
    'audio.src: a path must not contain "." or ".." segments, got "audio/../../theme.mp3"',
  ])

  const loud = parseSpec("video", { ...video(), audio: { src: "audio/theme.mp3", volume: -0.1 } })
  assert.equal(loud.spec, undefined)
  assert.deepEqual(loud.errors, ["audio.volume: expected a number between 0 and 1, got -0.1"])

  const engine = parseSpec("video", { ...video(), engine: "wan-2.2" })
  assert.equal(engine.spec, undefined)
  assert.deepEqual(engine.errors, ['engine: expected "hyperframes", got "wan-2.2"'])

  const gif = parseSpec("video", { ...video(), output: { format: "gif" } })
  assert.equal(gif.spec, undefined)
  assert.deepEqual(gif.errors, ['output.format: expected "mp4" or "webm", got "gif"'])

  // A misspelled key is still refused, at its own address: the version is the escape hatch, not permissiveness.
  const extra = parseSpec("video", { ...video(), autoplay: true })
  assert.equal(extra.spec, undefined)
  assert.deepEqual(extra.errors, ["autoplay: unknown key"])
})

// ---------------------------------------------------------------------------------------------------------------------
// The project: what a spec becomes on disk, before an engine is asked anything.

test("a video project is one self-contained page whose scenes are cut at the spec's durations", (t) => {
  const job = jobFor(t)
  mkdirSync(join(job, "audio"))
  writeFileSync(join(job, "audio", "theme.mp3"), "not really audio, but it is a file")
  const spec = parsedVideo(video())

  const project = writeVideoProject(spec, job)
  assert.equal(project.dir, resolve(job))
  assert.deepEqual(project.files, ["index.html", "hyperframes.json", "meta.json"])
  assert.equal(project.audio, "audio/theme.mp3")
  assert.equal(project.duration, 5)
  assert.deepEqual(
    project.scenes.map((scene) => [scene.id, scene.start, scene.duration, scene.midpoint]),
    [
      ["opening", 0, 2.5, 1.25],
      ["closing", 2.5, 2.5, 3.75],
    ],
  )
  // The acceptance lines travel with the scene as values; they are for a later check, not for the page.
  assert.deepEqual(project.scenes[0]?.acceptance, ["the title is readable for the whole scene"])

  const html = readFileSync(join(project.dir, "index.html"), "utf8")
  // The render runs with the network unshared: no external script, stylesheet, font or image.
  assert.equal(html.includes("http://"), false, "a video render must not fetch a plain http URL")
  assert.equal(html.includes("https://"), false, "a video render must not fetch an https URL")
  assert.equal(/<script\s+src=/i.test(html), false, "every script is inline")
  // Each scene is a composition section with its own window, and the captions are on-screen text in that section.
  assert.ok(html.includes('data-composition-id="opening"'))
  assert.ok(html.includes('data-start="2.5" data-duration="2.5"'))
  const opening = html.slice(html.indexOf('id="scene-opening"'), html.indexOf('id="scene-closing"'))
  assert.ok(opening.includes("<h2>Opening</h2>"))
  assert.ok(opening.includes('<div class="captions">'))
  assert.ok(opening.includes("<p>the release</p>"))
  assert.ok(opening.includes("<p>what it changes</p>"), "every caption line is on screen")
  // The audio bed is an audio element with the gain the spec asked for, while the root carries the film's length.
  assert.ok(html.includes('<audio id="audio-track"'))
  assert.ok(html.includes('src="audio/theme.mp3"'))
  assert.ok(html.includes('data-volume="0.6"'))
  assert.ok(html.includes('data-duration="5" data-width="640" data-height="360" data-fps="24"'))
  // Every composition host registers an empty timeline, so the producer does not wait on a scene that never reports.
  assert.ok(html.includes('window.__timelines["opening"]'))
  assert.ok(html.includes('window.__timelines["closing"]'))

  // Private files beside a private job, and the same spec writes the same bytes.
  assert.equal(statSync(job).mode & 0o777, 0o700)
  for (const name of project.files) assert.equal(statSync(join(project.dir, name)).mode & 0o777, 0o600, name)
  const other = jobFor(t)
  mkdirSync(join(other, "audio"))
  writeFileSync(join(other, "audio", "theme.mp3"), "not really audio, but it is a file")
  const again = writeVideoProject(spec, other)
  for (const name of project.files) {
    assert.equal(readFileSync(join(again.dir, name), "utf8"), readFileSync(join(project.dir, name), "utf8"), name)
  }
})

test("a project refuses a scene id that could leave the job, a missing asset and an audio file that is not there", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mm-video-refuse-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const job = join(root, "job")
  mkdirSync(job)

  const spec = parsedVideo(video())
  const escaped = { ...spec, scenes: [{ ...spec.scenes[0]!, id: "../escape" }] } as unknown as VideoSpec
  assert.throws(() => writeVideoProject(escaped, job), /not a safe composition id/)

  const rootId = { ...spec, scenes: [{ ...spec.scenes[0]!, id: "video" }] } as unknown as VideoSpec
  assert.throws(() => writeVideoProject(rootId, job), /root composition's own id/)

  // spec.ts refuses the text of a path that is absolute or climbs; this is the same rule for a cast, plus the file.
  const absolute = { ...spec, scenes: [{ ...spec.scenes[0]!, asset: "/etc/passwd" }] } as unknown as VideoSpec
  assert.throws(() => writeVideoProject(absolute, job), /is absolute/)

  const missing = { ...spec, scenes: [{ ...spec.scenes[0]!, asset: "assets/absent.png" }] } as unknown as VideoSpec
  assert.throws(() => writeVideoProject(missing, job), /not a file inside the job directory/)

  const noAudio = { ...spec, audio: { src: "audio/absent.mp3" } } as unknown as VideoSpec
  assert.throws(() => writeVideoProject(noAudio, job), /audio "audio\/absent\.mp3" is not a file/)

  // A refusal is a refusal: the job was empty and stays empty.
  assert.deepEqual(readdirSync(job), [])
})

// ---------------------------------------------------------------------------------------------------------------------
// The adapter: its declaration and the two guards.

test("the video adapter is an adapter, declares its engine and environment, and refuses a deck in prepare", async (t) => {
  const adapter = videoAdapter()
  assertAdapter(adapter)
  assert.equal(adapter.kind, "video")
  assert.equal(adapter.name, "hyperframes")
  assert.deepEqual(adapter.executables, ["hyperframes", "ffprobe", "ffmpeg"], "the engine renders; the QA pass reads the file")
  assert.equal(adapter.network, true, "the preview server is the one networked verb")
  assert.deepEqual(adapter.env, [...HYPERFRAMES_ENV_NAMES])
  for (const step of ["prepare", "render", "snapshot", "check", "openEditor", "cancel"]) {
    assert.equal(typeof adapter[step as "prepare"], "function", `${step} must exist`)
  }

  const job = jobFor(t)
  // The engine is asked first, as a real prepare would; a fake answers the version so the refusal that follows is about
  // the spec and not about this machine.
  const runner = fakeRunner(passed("0.9.54\n"))
  const { ctx } = harnessFor(job, runner)

  // The type parameter is the compile-time half of the guard: this line does not typecheck without the cast.
  // @ts-expect-error a DeckSpec is not a VideoSpec, so a video adapter cannot be handed one
  const refused = adapter.prepare(deckSpec(), ctx)
  await assert.rejects(refused, /video: it is a "deck" spec, not a video/)
  // Nothing was written, and no deck render was ever attempted through this adapter.
  assert.deepEqual(readdirSync(job), [])
  assert.equal(runner.calls.some((call) => call.args.includes("render")), false)
  // `present` is the deck's verb. A film has a preview server and, for the editor, `open`; it never presents a deck.
  assert.equal("present" in adapter, false)
})

test("the video checks are a registry, and the QA ids say which answers this host can honestly give", () => {
  assertRegistry(VIDEO_CHECKS)
  assert.deepEqual(
    VIDEO_CHECKS.map((def) => def.id),
    [
      "video.count",
      "video.duration",
      "video.lint",
      "video.runtime",
      "video.snapshot",
      ...QA_CHECK_IDS,
    ],
  )
  for (const def of VIDEO_CHECKS) assert.equal(def.required, true, `${def.id} is required`)
  // The three skips that are predicted rather than discovered: a transcript and a VLM review have no local model and may
  // not call a cloud one (D13/D21), and a film with no audio has no silence to measure (B2 has no narration).
  assert.deepEqual(
    VIDEO_CHECKS.filter((def) => def.skippable === true).map((def) => def.id),
    ["video.silence", "video.transcript", "video.vlm"],
  )
  // The QA ids are the class of answer this adapter now produces; the registry asserts their levels, and the video's
  // mechanical rules above are still the ones that ran before a file existed.
  for (const id of QA_CHECK_IDS) assert.ok(VIDEO_CHECKS.some((def) => def.id === id), `${id} is in the registry`)
})

test("a video's checks read the project and the engine's envelope, and a missing section fails rather than passes", (t) => {
  const job = jobFor(t)
  const spec = parsedVideo(video())
  mkdirSync(join(job, "audio"))
  writeFileSync(join(job, "audio", "theme.mp3"), "audio")
  const project = writeVideoProject(spec, job)

  const good = {
    lint: { ok: true, findings: [{ code: "note", severity: "info", message: "a note" }] },
    runtime: { ok: true, findings: [] },
  }
  const shots = project.scenes.map((scene) => join(job, `${scene.id}.png`))
  const results = videoResults({ spec, project, report: good, shots }, VIDEO_CHECKS)
  const byId = (results: readonly CheckResult[], id: string): CheckResult => {
    const found = results.find((result) => result.id === id)
    assert.ok(found, `the results must carry ${id}`)
    return found
  }
  assert.equal(byId(results, "video.count").status, "passed")
  assert.equal(byId(results, "video.duration").status, "passed")
  assert.equal(byId(results, "video.duration").output, "5 s across 2 scenes")
  assert.equal(byId(results, "video.lint").status, "passed")
  assert.equal(byId(results, "video.runtime").status, "passed")
  assert.equal(byId(results, "video.snapshot").status, "passed")

  const missing = videoResults({ spec, project, shots }, VIDEO_CHECKS)
  assert.equal(missing.find((result) => result.id === "video.lint")?.status, "failed")
  assert.equal(missing.find((result) => result.id === "video.runtime")?.status, "failed")

  const broken = videoResults(
    {
      spec,
      project,
      report: {
        lint: { ok: false, findings: [{ code: "missing_local_asset", severity: "error", message: "gone.png is missing" }] },
        runtime: { ok: false, findings: [{ code: "console_error", severity: "error", message: "boom" }] },
      },
      shots: ["one.png"],
    },
    VIDEO_CHECKS,
  )
  assert.equal(broken.find((result) => result.id === "video.lint")?.status, "failed")
  assert.match(broken.find((result) => result.id === "video.lint")?.reason ?? "", /gone\.png/)
  assert.equal(broken.find((result) => result.id === "video.runtime")?.status, "failed")
  assert.match(broken.find((result) => result.id === "video.runtime")?.reason ?? "", /boom/)
  assert.equal(broken.find((result) => result.id === "video.snapshot")?.status, "failed")

  // A definition that is the spec parse's is a skip with a reason, never a pass.
  const contract = videoResults({ spec, project }, [
    { id: "video.contract", level: "L0", kind: "video", title: "the video spec parses", run: "spec", required: true },
  ])
  assert.equal(contract[0]?.status, "skipped")
  assert.match(contract[0]?.reason ?? "", /spec parse/)
  assert.deepEqual(evaluate(VIDEO_CHECKS, results).invalid, [])
})

// ---------------------------------------------------------------------------------------------------------------------
// The QA pass (B2-T4): the frame rules, the two absences, and the fix loop. The judgements are functions of frames, so
// these tests build real PNGs with the encoder the deck's blank check already uses; no browser is started.

// One frame of one grey level. A film is judged on luminance and on change, so a grey still is the smallest picture that
// can express both.
const still = (shade: number) => frame(48, 32, () => [shade, shade, shade, 255])
const sample = (at: number, scene: string | undefined, shade: number): QaSample => ({
  at,
  ...(scene !== undefined ? { scene } : {}),
  image: still(shade),
})

// A whole QA report with one check failed and every other check in the state it would be in on a film with no audio and
// no local models. The fix loop is about which failures a proposal answers, so the report has to look like a real one.
const reportWith = (check: QaCheck | undefined): QaReport => ({
  sceneIds: ["one", "two"],
  frames: [],
  passed: check === undefined,
  checks: QA_CHECK_IDS.map((id): QaCheck => {
    if (check !== undefined && check.id === id) return check
    const absent = id === "video.silence" || id === "video.transcript" || id === "video.vlm"
    return { id, status: absent ? "skipped" : "passed", text: absent ? "not measured here" : "ok" }
  }),
})

const checkIn = (checks: readonly QaCheck[], id: string): QaCheck => {
  const found = checks.find((check) => check.id === id)
  assert.ok(found, `the QA pass must answer ${id}`)
  return found
}

test("the frame rules find a black run, a freeze across a cut and a flash, and pass a clean set", () => {
  const black = qaChecks({
    file: "video.mp4",
    duration: 2,
    samples: [sample(0.2, "one", 128), sample(0.6, "one", 0), sample(1.0, "one", 0), sample(1.4, "one", 128)],
  })
  const blackCheck = checkIn(black, "video.black")
  assert.equal(blackCheck.status, "failed")
  assert.match(blackCheck.text, /2 black frames at 0\.6, 1 s/)
  assert.equal(checkIn(black, "video.freeze").status, "passed")
  assert.equal(checkIn(black, "video.flash").status, "passed")

  // Identical frames inside one scene are a title card, not a freeze; the same frame on both sides of a cut is a freeze.
  const freeze = qaChecks({
    file: "video.mp4",
    duration: 2,
    samples: [sample(0.2, "one", 128), sample(0.8, "one", 128), sample(1.4, "two", 128), sample(2.0, "two", 200)],
  })
  assert.equal(checkIn(freeze, "video.black").status, "passed")
  const freezeCheck = checkIn(freeze, "video.freeze")
  assert.equal(freezeCheck.status, "failed")
  assert.match(freezeCheck.text, /the cut at 1\.4 s shows the same frame in scenes one and two/)
  assert.deepEqual(freezeCheck.scenes, ["one", "two"])

  const flash = qaChecks({
    file: "video.mp4",
    duration: 2,
    samples: [sample(0.2, "one", 32), sample(0.8, "one", 255), sample(1.4, "one", 32)],
  })
  assert.equal(checkIn(flash, "video.flash").status, "failed")
  assert.match(checkIn(flash, "video.flash").text, /255\/255 bright/)
  assert.deepEqual(judgeFrames([sample(0, "one", 32), sample(1, "one", 255), sample(2, "one", 32)]).map((fault) => fault.kind), [
    "flash",
  ])

  const clean = qaChecks({
    file: "video.mp4",
    duration: 2,
    samples: [sample(0.2, "one", 64), sample(0.8, "one", 64), sample(1.4, "two", 160), sample(2.0, "two", 160)],
  })
  assert.equal(checkIn(clean, "video.black").status, "passed")
  assert.equal(checkIn(clean, "video.freeze").status, "passed")
  assert.equal(checkIn(clean, "video.flash").status, "passed")
  assert.deepEqual(judgeFrames([]), [])

  // Nothing was sampled at all: every frame rule says it did not look, and none of them passes on an empty set.
  const none = qaChecks({ file: "video.mp4", sampleReason: "ffmpeg is not runnable here" })
  for (const id of ["video.black", "video.freeze", "video.flash"]) {
    assert.equal(checkIn(none, id).status, "skipped")
    assert.match(checkIn(none, id).text, /not runnable/)
  }
})

test("probe, sample times, and the three skips: no audio, no speech model, no vision model", () => {
  const probe = readProbe(
    JSON.stringify({
      format: { duration: "5.000000" },
      streams: [
        { index: 0, codec_type: "video", width: 640, height: 360, r_frame_rate: "24/1" },
        { index: 1, codec_type: "data" },
      ],
    }),
  )
  assert.ok(probe)
  assert.equal(probe.duration, 5)
  assert.equal(probe.audio, false)
  assert.deepEqual(probe.video, { width: 640, height: 360, fps: 24 })
  assert.equal(readProbe('{"streams":[]}'), undefined, "a file with no duration is not a probe")
  assert.equal(readProbe("not json"), undefined)

  // The sample grid is the scene midpoints plus a uniform spread, deduplicated, and every frame knows its scene.
  const times = sampleTimes(5, [
    { id: "one", start: 0, duration: 2.5 },
    { id: "two", start: 2.5, duration: 2.5 },
  ])
  assert.ok(times.some((entry) => entry.at === 1.25 && entry.scene === "one"), JSON.stringify(times))
  assert.ok(times.some((entry) => entry.at === 3.75 && entry.scene === "two"), JSON.stringify(times))
  assert.ok(times.length <= 12 && times.length >= 4)
  assert.deepEqual([...times].map((entry) => entry.at), [...times.map((entry) => entry.at)].sort((a, b) => a - b))
  for (const entry of times) assert.ok(entry.at >= 0 && entry.at < 5)

  const checks = qaChecks({
    file: "video.mp4",
    duration: 5,
    probe,
    samples: [sample(0.2, "one", 64), sample(0.8, "one", 64), sample(1.4, "two", 160), sample(2.0, "two", 160)],
  })
  const silence = checkIn(checks, "video.silence")
  assert.equal(silence.status, "skipped")
  assert.match(silence.text, /no audio track, so there is no silence to find/)
  for (const id of ["video.transcript", "video.vlm"]) {
    const check = checkIn(checks, id)
    assert.equal(check.status, "skipped")
    assert.match(check.text, /D13\/D21/)
  }

  // The silence parser pairs ffmpeg's log lines and closes a start the file ran out on at the duration.
  assert.deepEqual(readSilence("silence_start: 1.25\nsilence_end: 2.5 | silence_duration: 1.25\n", 5), [
    { start: 1.25, end: 2.5 },
  ])
  assert.deepEqual(readSilence("silence_start: 4\n", 5), [{ start: 4, end: 5 }])
})

test("evaluate sees the transcript and the VLM as skips, not as passes", (t) => {
  const job = jobFor(t)
  const spec = demo()
  const project = writeVideoProject(spec, job)
  const checks = qaChecks({ file: "video.mp4" })
  const qa: QaReport = { checks, sceneIds: ["one", "two"], frames: [], passed: true }
  const results = videoResults({ spec, project, qa }, VIDEO_CHECKS)
  const coverage = evaluate(VIDEO_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(
    coverage.skipped.map((result) => result.id).sort(),
    ["video.black", "video.flash", "video.freeze", "video.silence", "video.transcript", "video.vlm"],
  )
  for (const result of coverage.skipped) assert.ok((result.reason ?? "").length > 0, `${result.id} must say why`)
  // The registry declared these three in advance, so the gate treats their absence as a warning rather than a lie.
  const predicted = new Set(["video.silence", "video.transcript", "video.vlm"])
  for (const result of coverage.skipped.filter((entry) => predicted.has(entry.id))) {
    assert.ok(VIDEO_CHECKS.find((def) => def.id === result.id)?.skippable, `${result.id} is declared skippable`)
  }
})

test("the fix loop stops at three rounds, applies only allowlisted repairs, and reports a content change", async () => {
  const freeze = reportWith({ id: "video.freeze", status: "failed", text: "the cut at 2.5 s repeats", scenes: ["one"] })
  let rendered = 0
  const applied: SafeFix[] = []
  const result = await qaRounds({
    render: async () => {
      rendered += 1
    },
    qa: async () => freeze,
    fixes: {
      propose: async () => [
        { op: "extend", scene: "one", ms: 250 },
        { op: "extend", scene: "one", ms: 10_000 },
        { op: "rewrite", scene: "one", text: "a new sentence" },
        { op: "extend", scene: "one", ms: 100, text: "a new sentence" },
      ],
      apply: async (fix) => {
        applied.push(fix)
      },
    },
  })

  assert.equal(rendered, QA_ROUNDS, "three renders is the whole budget")
  assert.equal(result.stopped, "rounds")
  assert.deepEqual(applied, [
    { op: "extend", scene: "one", ms: 250 },
    { op: "extend", scene: "one", ms: 250 },
  ])
  // One safe repair per round, and the three content or cap violations refused each time.
  assert.equal(result.refused.length, 6)
  assert.ok(result.refused.some((entry) => /outside 1–500 ms/.test(entry.reason)))
  assert.ok(result.refused.some((entry) => /wording/.test(entry.reason)))
  assert.ok(result.applied.every((fix) => fix.op === "extend"))
  // The report a person gets names the failure the loop could not clear.
  assert.ok(result.needsHuman.some((line) => line.startsWith("video.freeze:")))
  assert.ok(result.needsHuman.some((line) => line.includes("3 rounds")))
})

test("a first pass that passes stops the loop before any fix is proposed", async () => {
  let rendered = 0
  let proposed = 0
  const result = await qaRounds({
    render: async () => {
      rendered += 1
    },
    qa: async () => reportWith(undefined),
    fixes: {
      propose: async () => {
        proposed += 1
        return []
      },
      apply: async () => {},
    },
  })
  assert.equal(rendered, 1)
  assert.equal(proposed, 0)
  assert.equal(result.stopped, "passed")
  assert.deepEqual(result.applied, [])
  assert.deepEqual(result.needsHuman, [])
})

test("a fix that answers a different failure, or names no scene, is refused with the reason", () => {
  const freeze = reportWith({ id: "video.freeze", status: "failed", text: "the cut repeats", scenes: ["one"] })
  // A flash was not reported, so a shift — a valid operation with a valid length — would move a cut for no reason.
  assert.match(classifyFix({ op: "shift", scene: "one", ms: 100 }, freeze).reason ?? "", /no video\.flash failure/)
  assert.match(classifyFix({ op: "extend", scene: "two", ms: 100 }, freeze).reason ?? "", /did not name scene two/)
  assert.match(classifyFix({ op: "extend", scene: "absent", ms: 100 }, freeze).reason ?? "", /not one of the film's scenes/)
  assert.match(classifyFix({ op: "extend", scene: "one", ms: 0 }, freeze).reason ?? "", /outside 1–500 ms/)
  assert.deepEqual(classifyFix({ op: "extend", scene: "one", ms: 100 }, freeze).fix, {
    op: "extend",
    scene: "one",
    ms: 100,
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The argv a run is handed, without an engine: a render asks for the spec's settings and a snapshot for every midpoint.

test("render asks for the spec's fps, container and quality, software pixels, and writes inside the job", async (t) => {
  const job = jobFor(t)
  const calls: HostRunInput[] = []
  const runner: HostRunner = {
    async run(input: HostRunInput): Promise<HostRunResult> {
      calls.push(input)
      if (input.args[0] === "render") {
        // The adapter checks the file it asked for; the fake writes it, because the thing under test is the argv and the
        // output path, not the encoder.
        const out = input.args[input.args.indexOf("-o") + 1]
        assert.ok(out, "a render always names its output")
        writeFileSync(join(job, out), "a fake encode")
        return passed("rendered")
      }
      return passed("0.9.54\n")
    },
    cancel(): void {},
  }
  const { ctx } = harnessFor(job, runner)
  const adapter = videoAdapter()
  mkdirSync(join(job, "audio"))
  writeFileSync(join(job, "audio", "theme.mp3"), "audio")
  await adapter.prepare(parsedVideo(video()), ctx)
  const rendered = await adapter.render(ctx)

  assert.deepEqual(rendered.outputs, ["video.mp4"])
  assert.ok(existsSync(join(job, "video.mp4")))
  const call = calls.find((entry) => entry.args[0] === "render")
  assert.ok(call, "the adapter asked the engine to render")
  const args = call.args
  assert.equal(args.includes("--fps"), true)
  assert.equal(args[args.indexOf("--fps") + 1], "24")
  assert.equal(args[args.indexOf("--format") + 1], "mp4")
  assert.equal(args[args.indexOf("-o") + 1], "video.mp4", "the output name is the adapter's")
  // The spec's "high" is the engine's delivery step; a missing quality would leave the engine's default in place.
  assert.equal(args[args.indexOf("--quality") + 1], "high")
  // A render wants pixels and the deck's determinism argument applies to them: software SwiftShader on every machine.
  for (const flag of BROWSER_GPU_ARGS) assert.ok(args.includes(flag), `a render must pass ${flag}: ${args.join(" ")}`)
  // Nothing the deck owns is in this argv: the video adapter is the one that encodes.
  assert.equal(args.includes("present"), false)
})

test("snapshot asks for one frame per scene, at the scene's midpoint, with the end frame off", async (t) => {
  const job = jobFor(t)
  const runner = fakeRunner(
    passed("0.9.54\n"),
    passed(
      JSON.stringify({
        ok: true,
        frames: [
          { path: join(job, ".hyperframes", "artifacts", "a.png"), time: 1.25 },
          { path: join(job, ".hyperframes", "artifacts", "b.png"), time: 3.75 },
        ],
      }),
    ),
  )
  const { ctx } = harnessFor(job, runner)
  const adapter = videoAdapter()
  await adapter.prepare(demo(), ctx)
  const snapshot = await adapter.snapshot(ctx)

  assert.deepEqual(snapshot.shots.map((shot) => shot.label), ["one", "two"])
  for (const shot of snapshot.shots) assert.equal(resolve(job, shot.path).startsWith(resolve(job)), true)
  const call = runner.calls.find((entry) => entry.args[0] === "snapshot")
  assert.ok(call, "the adapter asked the engine to snapshot")
  assert.deepEqual(call.args, ["snapshot", "--json", "--no-browser-gpu", "--no-end", "--at", "1.25,3.75"])
})

test("the lint verb reads the engine's own lint envelope and a refusal is a sentence, not a throw", async (t) => {
  const job = jobFor(t)
  const ok = fakeRunner(passed(JSON.stringify({ ok: true, errorCount: 0, warningCount: 1, findings: [] })))
  const report = await hyperframesLint(ok, job)
  assert.equal(report.ok, true)
  assert.deepEqual(ok.calls[0]?.args, ["lint", "--json"])

  const refused = fakeRunner({ ...failed(-1), refused: 'executable "hyperframes" is not on this adapter\'s allowlist' })
  const none = await hyperframesLint(refused, job)
  assert.equal(none.ok, false)
  assert.match(none.refused ?? "", /allowlist/)

  const banner = await hyperframesLint(fakeRunner(passed("lint: all good\n")), job)
  assert.equal(banner.ok, false)
  assert.match(banner.refused ?? "", /no JSON envelope/)
})

test("openEditor hands the project to the studio, and a host without the app is told what it needs", async (t) => {
  const job = jobFor(t)
  const runner = fakeRunner(
    passed("0.9.54\n"),
    passed("The HyperFrames desktop app isn't installed on this computer.\n   Download it: https://example.test/studio\n"),
  )
  const { ctx } = harnessFor(job, runner)
  const adapter = videoAdapter()
  await adapter.prepare(demo(), ctx)

  // The desktop app is the video's editor; `open` is the verb, and the browser surface is the preview server.
  await assert.rejects(adapter.openEditor!(ctx), /needs the HyperFrames desktop app/)
  const call = runner.calls.find((entry) => entry.args[0] === "open")
  assert.ok(call, "the adapter asked the engine to open the project")
  assert.equal(call.args[0], "open")
  assert.equal(call.args.includes("present"), false)
})

test("every video call goes through hyperframesRun, which names the engine and the declared environment", async (t) => {
  const job = jobFor(t)
  const calls: HostRunInput[] = []
  const fake: HostRunner = {
    async run(input) {
      calls.push(input)
      return passed("{}")
    },
    cancel() {},
  }
  await hyperframesRun(fake, ["lint", "--json"], { jobDir: job })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.exe, "hyperframes")
  assert.deepEqual(calls[0]?.args, ["lint", "--json"])
  assert.equal(calls[0]?.cwd, resolve(job))
  assert.deepEqual(calls[0]?.env, { HYPERFRAMES_CHROME_SANDBOX: "0" })
  assert.ok(existsSync(join(job, ".home", ".cache", "hyperframes")), "the browser cache link is made under the job")
})

// ---------------------------------------------------------------------------------------------------------------------
// The engine, through the real host runner. Each test skips only when the host says it cannot run a program.

test("a five second, 640x360 demo renders to an mp4 inside the job, and ffprobe measures about five seconds", async (t) => {
  const job = jobFor(t)
  const adapter = videoAdapter()
  const runner = await hostRunnerFor(adapter, { jobDir: job, timeoutMs: 240_000 })
  const { ctx, logs } = harnessFor(job, runner)
  const spec = demo()

  try {
    await adapter.prepare(spec, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hostLimitation(message)) return t.skip(`no HyperFrames through the runner here: ${message}`)
    throw error
  }

  try {
    const rendered = await adapter.render(ctx)
    assert.deepEqual(rendered.outputs, ["video.mp4"])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hostLimitation(message)) return t.skip(`no renderer through the runner here: ${message}`)
    throw error
  }

  const output = join(job, "video.mp4")
  assert.ok(existsSync(output), "the render wrote the file it named")
  assert.ok(statSync(output).size > 0, `${output} is not empty`)

  // ffprobe is a second program the runner has to allow. `hostRunnerFor` derives its allowlist from the adapter, which
  // names only hyperframes, so this is a runner built with the two names this proof needs — the same rule, a wider list.
  const probe = await createHostRunner({
    allow: ["hyperframes", "ffprobe"],
    jobDir: job,
    network: false,
    env: [...HYPERFRAMES_ENV_NAMES],
    timeoutMs: 30_000,
  })
  const measured = await probe.run({
    exe: "ffprobe",
    args: ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", "video.mp4"],
  })
  if (!measured.passed) {
    // A host without ffprobe is a host limitation, not a wrong render; the file's size and mtime are then the only
    // evidence, and its existence above is what they add to.
    if (hostLimitation(measured.refused) || /not found/.test(measured.stderr)) {
      t.diagnostic(`ffprobe is not runnable here (${measured.refused ?? measured.stderr.trim()}); the file's size and existence were checked instead`)
    } else {
      assert.fail(`ffprobe refused the render: ${measured.refused ?? measured.stderr}`)
    }
    return
  }

  const envelope = JSON.parse(measured.stdout) as {
    format?: { duration?: string }
    streams?: readonly { width?: number; height?: number }[]
  }
  const duration = Number(envelope.format?.duration)
  assert.ok(Number.isFinite(duration), `ffprobe must report a duration: ${measured.stdout}`)
  assert.ok(Math.abs(duration - 5) <= 0.2, `the render must last about 5 s, ffprobe says ${duration}: ${logs.join(" | ")}`)
  assert.deepEqual(
    [envelope.streams?.[0]?.width, envelope.streams?.[0]?.height],
    [640, 360],
    "the render is the size the spec asked for",
  )
})

test("the demo renders, the QA pass reads the file, and the report names every check with its status", async (t) => {
  const job = jobFor(t)
  const adapter = videoAdapter()
  const runner = await hostRunnerFor(adapter, { jobDir: job, timeoutMs: 240_000 })
  const { ctx, logs } = harnessFor(job, runner)

  try {
    await adapter.prepare(demo(), ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hostLimitation(message)) return t.skip(`no HyperFrames through the runner here: ${message}`)
    throw error
  }

  const renderStarted = Date.now()
  try {
    await adapter.render(ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hostLimitation(message)) return t.skip(`no renderer through the runner here: ${message}`)
    throw error
  }
  const renderMs = Date.now() - renderStarted

  // The pipeline order is render → snapshot → check: the scene frames are the snapshot step's, and the QA pass reads the
  // encoded file. Both are part of the one report.
  const snapshot = await adapter.snapshot(ctx)
  if (snapshot.shots.length !== 2) {
    const said = logs.join(" | ")
    if (hostLimitation(said)) return t.skip(`no browser through the runner here: ${said}`)
    assert.fail(`the demo did not snapshot to two frames: ${snapshot.shots.length}\n${said}`)
  }

  const qaStarted = Date.now()
  const results = await adapter.check(ctx, VIDEO_CHECKS)
  const qaMs = Date.now() - qaStarted
  const byId = (id: string): CheckResult => {
    const found = results.find((result) => result.id === id)
    assert.ok(found, `the report must name ${id}`)
    return found
  }

  // Every check the registry has, and every status a result can carry, in one line a person can read.
  assert.deepEqual(
    results.map((result) => result.id),
    VIDEO_CHECKS.map((def) => def.id),
  )
  for (const result of results) assert.ok(["passed", "failed", "skipped"].includes(result.status), result.id)
  const line = results.map((result) => `${result.id}=${result.status}`).join(" ")
  t.diagnostic(`render ${renderMs} ms, check+QA ${qaMs} ms: ${line}`)
  assert.deepEqual(evaluate(VIDEO_CHECKS, results).invalid, [])

  // The frames of a two-scene title film are not black, do not repeat across the cut, and have no flash.
  for (const id of ["video.black", "video.freeze", "video.flash"]) {
    const result = byId(id)
    if (result.status === "failed") {
      const said = `${id}: ${result.reason ?? ""}`
      if (hostLimitation(said) || /ffmpeg is not runnable/.test(said)) return t.skip(`no frame sampler here: ${said}`)
      assert.fail(said)
    }
    assert.equal(result.status, "passed", `${id}: ${result.reason ?? ""}`)
  }
  // The demo has no audio bed, so the silence check says there is nothing to measure; the two model checks say why no
  // model ran. None of the three is a green line for a look that never happened.
  const silence = byId("video.silence")
  assert.equal(silence.status, "skipped")
  assert.match(silence.reason ?? "", /no audio track/)
  for (const id of ["video.transcript", "video.vlm"]) {
    assert.equal(byId(id).status, "skipped")
    assert.match(byId(id).reason ?? "", /D13\/D21/)
  }

  // The engine's own checks still pass on the same project, so the QA pass was added to them rather than replacing them.
  assert.equal(byId("video.lint").status, "passed", byId("video.lint").reason)
  assert.equal(byId("video.duration").output, "5 s across 2 scenes")
  assert.ok(!line.includes("=failed"), `${line}\n${logs.join(" | ")}`)
})

test("the demo snapshots one frame per scene and its check passes lint, runtime and the count", async (t) => {
  const job = jobFor(t)
  const adapter = videoAdapter()
  const runner = await hostRunnerFor(adapter, { jobDir: job, timeoutMs: 240_000 })
  const { ctx, logs } = harnessFor(job, runner)

  try {
    await adapter.prepare(demo(), ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hostLimitation(message)) return t.skip(`no HyperFrames through the runner here: ${message}`)
    throw error
  }

  const snapshot = await adapter.snapshot(ctx)
  if (snapshot.shots.length !== 2) {
    const said = logs.join(" | ")
    if (hostLimitation(said)) return t.skip(`no browser through the runner here: ${said}`)
    assert.fail(`the demo did not snapshot to two frames: ${snapshot.shots.length}\n${said}`)
  }
  for (const shot of snapshot.shots) {
    assert.ok(existsSync(join(job, shot.path)), `the shot the adapter returns exists: ${shot.path}`)
    assert.ok(statSync(join(job, shot.path)).size > 0, `${shot.path} is not empty`)
  }

  const results = await adapter.check(ctx, VIDEO_CHECKS)
  const coverage = evaluate(VIDEO_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(coverage.missing, [])
  if (coverage.failed.length > 0) {
    const said = coverage.failed.map((result) => `${result.id}: ${result.reason ?? ""}`).join("; ")
    if (hostLimitation(said)) return t.skip(`the engine could not check here: ${said}`)
    assert.fail(said)
  }
  assert.equal(coverage.ok, true)
  assert.equal(results.find((result) => result.id === "video.snapshot")?.output, "2 frames for 2 scenes")
  assert.equal(results.find((result) => result.id === "video.runtime")?.output, "the page ran with no console error")

  // The standalone lint verb, on the same project, is the static pass without a second check report.
  const lint = await adapter.lint(ctx)
  assert.equal(lint.ok, true, lint.refused ?? lint.output)
})

test("the preview server starts on a free port, serves the project and stops when the run is cancelled", async (t) => {
  const job = jobFor(t)
  const adapter = videoAdapter()
  const runner = await hostRunnerFor(adapter, { jobDir: job, timeoutMs: 120_000 })
  const { ctx } = harnessFor(job, runner)

  try {
    await adapter.prepare(demo(), ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hostLimitation(message)) return t.skip(`no HyperFrames through the runner here: ${message}`)
    throw error
  }

  const started = await adapter.preview(ctx)
  if (!started.started) {
    if (hostLimitation(started.output)) return t.skip(`no preview server here: ${started.output}`)
    assert.fail(`the preview did not start: ${started.output}`)
  }
  const port = Number(/port (\d+)/.exec(started.output)?.[1])
  assert.ok(port > 0, started.output)

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
    assert.equal(page.status, 200)
  } finally {
    runner.cancel()
  }

  // The runner is one-run-at-a-time: cancelling the server is what frees it, and the port closing is how a test sees it.
  const closed = await portClosed(port)
  assert.equal(closed, true, "cancel() must stop the preview server")
})

// Whether the port refuses a connection, tried until it does or the deadline passes. Every wait is bounded so a server
// that does not die fails the test instead of hanging it.
function portClosed(port: number, ms = 5000): Promise<boolean> {
  return new Promise((done) => {
    const deadline = Date.now() + ms
    const attempt = (): void => {
      const socket = connect({ host: "127.0.0.1", port })
      socket.setTimeout(300, () => {
        socket.destroy()
        done(false)
      })
      socket.once("connect", () => {
        socket.destroy()
        if (Date.now() > deadline) done(false)
        else setTimeout(attempt, 100)
      })
      socket.once("error", () => {
        socket.destroy()
        done(true)
      })
    }
    attempt()
  })
}
