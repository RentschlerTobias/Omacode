// The deck adapter's precondition (B3-T0) is the first thing a deck job meets, so these tests fix what it answers: the
// version when HyperFrames is usable, and one actionable sentence when it is not. The fake runners are literal results,
// like the host runner's own tests (test/artifact.test.ts), because the point is the sentence and the exit code rather
// than a child process.
//
// The rest of the file fixes the slideshow project (B3-T2): what a spec becomes on disk, what the island keeps and drops,
// and whether the real engine can check, snapshot and present it through the real host runner. Those tests skip on a
// machine that has no HyperFrames (or no runnable bubblewrap) for a reason the runner itself states; a failure that is
// not a host limitation fails the test.

import assert from "node:assert/strict"
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer, connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test, type TestContext } from "node:test"

import {
  DECK_CHECKS,
  DECK_ENV_NAMES,
  HYPERFRAMES_INSTALL,
  MAX_ASSET_BYTES,
  checkHyperframes,
  deckAdapter,
  deckCheck,
  deckPresent,
  deckResults,
  deckSnapshot,
  hyperframesTool,
  placeholderNote,
  writeDeckProject,
  type DeckCheck,
  type DeckProject,
} from "../packages/artifact/src/adapters/deck.ts"
import { assertAdapter, type AdapterContext, type HostRunInput, type HostRunResult, type HostRunner } from "../packages/artifact/src/adapter.ts"
import { CONTRACT_CHECKS, SKIPPED_CODE, assertRegistry, evaluate, type CheckResult } from "../packages/artifact/src/checks.ts"
import { buildProvenance, readProvenance, sha256File, specHash, writeProvenance } from "../packages/artifact/src/provenance.ts"
import { qualityGate } from "../packages/artifact/src/quality.ts"
import { createHostRunner, hostRunnerFor } from "../packages/artifact/src/runner.ts"
import { parseSpec, type DeckSpec } from "../packages/artifact/src/spec.ts"
import { artifactsRootFor, specFromPlan } from "../packages/micromanager/src/artifact/handoff.ts"
import { renderPlanDoc, type PlanDoc } from "../packages/micromanager/src/plandoc.ts"

interface FakeRunner extends HostRunner {
  readonly calls: readonly HostRunInput[]
}

// A runner that answers from a list and remembers what it was asked. The last answer repeats, so a test that does not
// care about the doctor attempt still exercises the code path that makes it; the calls list is how a test says which
// question came first.
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

// The shape `hyperframes doctor` prints on this machine: a blank line, its own heading, then ✓/✗/◇ rows. Only the first
// lines travel into a failure's detail, so the fixture carries a heading and two rows.
const doctorTable = [
  "",
  "hyperframes doctor",
  "",
  "  ✓ Version          0.9.54 (latest)",
  "  ✓ CLI binary       /home/someone/.local/bin/hyperframes",
  "  ✓ Node.js          v22.12.0 (linux x64)",
  "  ✗ whisper-cpp      Not found (optional — needed for transcription)",
  "  ◇  Some checks failed — see hints above",
].join("\n")

// A valid deck spec, parsed by the contract rather than hand-shaped, so a provenance test cannot pass on a spec the
// package would refuse. A deck is version 2 since B3-T1 added reveals, branches and hotspots.
const deckSpec = (): DeckSpec => {
  const parsed = parseSpec("deck", {
    kind: "deck",
    version: 2,
    job: "job-1",
    brief: "a deck about the release",
    slides: [{ id: "s1", title: "What shipped", body: "the release" }, { id: "s2" }],
  })
  assert.ok(parsed.spec, `the deck fixture must parse: ${parsed.errors.join("; ")}`)
  return parsed.spec as DeckSpec
}

test("a bare version on stdout is the version a deck would record", async () => {
  const run = fakeRunner(passed("0.9.54\n"))
  const check = await checkHyperframes(run)

  assert.equal(check.ok, true)
  assert.equal(check.version, "0.9.54")
  assert.equal(check.reason, undefined)
  // Two calls only on failure: a healthy engine is asked once, and nothing is written anywhere.
  assert.deepEqual(run.calls.map((call) => call.args), [["--version"]])
})

test("a banner around the version still yields the version, because a version is what provenance needs", async () => {
  const run = fakeRunner(passed("hyperframes v0.9.54 — Create and render slideshows\n"))
  const check = await checkHyperframes(run)

  assert.equal(check.ok, true)
  assert.equal(check.version, "0.9.54")
})

test("a refused run names the refusal and the install command, and the version is asked first", async () => {
  const refusal = {
    ...failed(-1),
    refused: 'executable "hyperframes" is not on this adapter\'s allowlist (node)',
  }
  const run = fakeRunner(refusal)
  const check = await checkHyperframes(run)

  assert.equal(check.ok, false)
  assert.ok(check.reason?.includes(HYPERFRAMES_INSTALL), check.reason)
  // The whole point of the sentence: it says why, not only that something is wrong.
  assert.ok(check.reason?.includes("not on this adapter's allowlist"), check.reason)
  assert.equal(run.calls[0]?.exe, "hyperframes")
  assert.deepEqual(run.calls[0]?.args, ["--version"])
  // The doctor attempt was refused too (the fake repeats the same answer), so there is no detail to show.
  assert.equal(check.detail, undefined)
})

test("a non-zero exit is named, and the doctor table is the detail rather than the verdict", async () => {
  const run = fakeRunner(failed(2, "boom\n"), passed(doctorTable))
  const check = await checkHyperframes(run)

  assert.equal(check.ok, false)
  assert.match(check.reason ?? "", /exited 2|boom/)
  assert.ok(check.reason?.includes(HYPERFRAMES_INSTALL), check.reason)
  assert.deepEqual(run.calls[1]?.args, ["doctor"])
  assert.ok(check.detail?.includes("hyperframes doctor"), check.detail)
  assert.ok(check.detail?.includes("whisper-cpp"), check.detail)
  // The optional extras doctor complains about are the reason it is a detail: a deck does not need a transcriber.
  assert.equal(check.ok, false)
})

test("output without a version is a failure, and the output is what the reader is shown", async () => {
  const run = fakeRunner(passed("not a version\n"), passed(doctorTable))
  const check = await checkHyperframes(run)

  assert.equal(check.ok, false)
  assert.match(check.reason ?? "", /no version/i)
  assert.ok(check.detail?.includes("not a version"), check.detail)
})

test("the tool row carries HyperFrames' licence and territory into the provenance a deck travels with", () => {
  const tool = hyperframesTool("0.9.54")
  assert.equal(tool.name, "hyperframes")
  assert.equal(tool.version, "0.9.54")
  assert.equal(tool.license, "Apache-2.0")
  assert.ok(tool.territory.length > 0)

  const spec = deckSpec()
  const provenance = buildProvenance({
    tool,
    inputs: [],
    spec: { kind: spec.kind, version: spec.version, sha256: specHash(spec) },
    createdAt: "2026-11-15T00:00:00Z",
  })
  assert.equal(provenance.tool.version, "0.9.54")
  assert.equal(provenance.tool.license, "Apache-2.0")
})

test("the machine's HyperFrames answers through the host runner, or the runner says why it cannot", async (t) => {
  const jobDir = mkdtempSync(join(tmpdir(), "mm-deck-"))
  t.after(() => rmSync(jobDir, { recursive: true, force: true }))

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: jobDir, network: false, env: [...DECK_ENV_NAMES] })
  const check = await checkHyperframes(runner)
  if (!check.ok) {
    // A machine without the binary, or without a runnable bubblewrap for the no-network declaration, is a host
    // limitation and not a failure of this code. Any other refusal would be a bug in the check, so it fails here.
    const hostLimitation = /was not found in|is not runnable here/.test(check.reason ?? "")
    if (hostLimitation) return t.skip(`no HyperFrames through the runner here: ${check.reason ?? ""}`)
    assert.fail(`HyperFrames is installed but the runner refused it: ${check.reason ?? ""}`)
  }
  assert.match(check.version ?? "", /^\d+\.\d+\.\d+/)
})

// ---------------------------------------------------------------------------------------------------------------------
// The slideshow project (B3-T2). A deck is data until it is a project, so these tests start with what the writer puts on
// disk: the composition, the island, and the two side files. Then they hand the project to the real engine through the
// real runner, because the wiring between the composition, the slideshow element and the island is not something a fake
// can vouch for.

interface IslandSlideView {
  readonly sceneId: string
  readonly fragments: readonly number[]
  readonly hotspots: readonly { readonly id: string; readonly label: string; readonly target: string }[]
  readonly notes?: string
}

interface IslandSequenceView {
  readonly id: string
  readonly label: string
  readonly slides: readonly IslandSlideView[]
}

const islandSlides = (project: ReturnType<typeof writeDeckProject>): readonly IslandSlideView[] =>
  project.island.slides as readonly IslandSlideView[]

const islandSequences = (project: ReturnType<typeof writeDeckProject>): readonly IslandSequenceView[] =>
  project.island.slideSequences as readonly IslandSequenceView[]

// A deck that exercises every part of the contract a project can show: a note, a reveal pair, a hidden slide and a
// hotspot that leads to a branch. The hidden slide is the sixth slide and the fifth manifest slide: it is written into
// the HTML and left out of the island, which is the difference the test is about.
const releaseDeck = (): DeckSpec => {
  const parsed = parseSpec("deck", {
    kind: "deck",
    version: 2,
    job: "job-1",
    brief: "a deck about the release",
    slides: [
      { id: "opening", title: "Opening the release", body: "what this deck is about", notes: "say it slowly" },
      { id: "shipped", title: "What shipped", body: "three things", reveals: [0, 1] },
      { id: "hidden-plan", title: "Plan B", body: "only if someone asks", hidden: true },
      {
        id: "next",
        title: "Next steps",
        body: "what comes after",
        hotspots: [{ id: "more", label: "The details", target: "details" }],
      },
      { id: "thanks", title: "Thank you", body: "questions" },
      { id: "closing", title: "Closing", body: "the end" },
    ],
    branches: [{ id: "details", label: "Under the hood", slides: [{ id: "how", title: "How it works", body: "the mechanism" }] }],
  })
  assert.ok(parsed.spec, `the deck fixture must parse: ${parsed.errors.join("; ")}`)
  return parsed.spec as DeckSpec
}

// A spec over the given slides, parsed by the contract rather than hand-shaped, so an asset test cannot pass on a spec
// the package would refuse. Asset paths are checked lexically by the parser too, which is why these fixtures stay inside
// the job the way a plan would.
const deckOf = (slides: readonly Record<string, unknown>[]): DeckSpec => {
  const parsed = parseSpec("deck", {
    kind: "deck",
    version: 2,
    job: "job-1",
    brief: "a deck about the release",
    slides,
  })
  assert.ok(parsed.spec, `the deck fixture must parse: ${parsed.errors.join("; ")}`)
  return parsed.spec as DeckSpec
}

// A job directory under its own temp root, so a test can also look beside the job to prove nothing was written there.
const jobFor = (t: TestContext): string => {
  const root = mkdtempSync(join(tmpdir(), "mm-deck-project-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const job = join(root, "job")
  mkdirSync(job)
  return job
}

// A port nothing is on. The socket is closed before the presenter is asked to use the number, so the CLI's own
// "port in use" fallback is not what makes the test pass.
const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  await new Promise<void>((done) => server.close(() => done()))
  assert.ok(port > 0, "the test must have a port")
  return port
}

// Whether the port refuses a connection, tried until it does or the deadline passes. Every wait in this file is bounded
// so a presenter that does not die fails the test instead of hanging it.
const portClosed = (port: number, ms = 5000): Promise<boolean> =>
  new Promise((done) => {
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

// The two skips this file is allowed to make, and nothing else. A missing binary or bubblewrap is the host's answer; a
// check whose browser could not start because the job's /dev is read-only is B1-T5's mount order, and it is named as a
// host limitation so a real defect in the project cannot hide behind it.
const engineMissing = (reason: string | undefined): boolean => /was not found in|is not runnable here/.test(reason ?? "")

const browserHostLimitation = (check: DeckCheck): string | undefined => {
  const report = check.report
  if (typeof report !== "object" || report === null) return undefined
  const text = JSON.stringify(report)
  if ((report as Record<string, unknown>)["browserSkipped"] === true && text.includes("EACCES")) {
    return `the host runner cannot start a browser here: the job's /dev is read-only under bubblewrap, so a child fails with "spawn ... EACCES" (B1-T5's mount order), not a problem with this project`
  }
  return undefined
}

test("a spec becomes a project whose island keeps the main line, the branch and the hotspot", (t) => {
  const job = jobFor(t)
  const project = writeDeckProject(releaseDeck(), job)

  assert.equal(project.dir, resolve(job))
  assert.deepEqual(project.files, ["index.html", "hyperframes.json", "meta.json"])
  assert.equal(project.slides, 5)

  const slides = islandSlides(project)
  assert.deepEqual(
    slides.map((slide) => slide.sceneId),
    ["opening", "shipped", "next", "thanks", "closing"],
  )
  // The hidden slide is not a slide the room will see, so it is not a scene the player can reach.
  assert.equal(slides.some((slide) => slide.sceneId === "hidden-plan"), false)
  assert.equal(slides[0]?.notes, "say it slowly")
  // The reveal pair is a pair of times inside the slide's own window (8 s to 16 s), not the indices as written.
  assert.deepEqual(slides[1]?.fragments, [10.667, 13.333])
  assert.deepEqual(slides[2]?.hotspots, [{ id: "more", label: "The details", target: "details" }])

  const sequences = islandSequences(project)
  assert.equal(sequences.length, 1)
  assert.equal(sequences[0]?.id, "details")
  assert.equal(sequences[0]?.label, "Under the hood")
  assert.deepEqual(sequences[0]?.slides.map((slide) => slide.sceneId), ["how"])

  // Every file is private and so is the job; the returned names are relative and resolve inside it.
  assert.equal(statSync(job).mode & 0o777, 0o700)
  for (const name of project.files) {
    assert.equal(statSync(join(project.dir, name)).mode & 0o777, 0o600, name)
  }

  // The same spec writes the same bytes: there is no clock and no random id in a project, so a second write can be
  // compared with the first and a provenance hash of the project would mean something.
  const again = writeDeckProject(releaseDeck(), jobFor(t))
  for (const name of project.files) {
    assert.equal(readFileSync(join(again.dir, name), "utf8"), readFileSync(join(project.dir, name), "utf8"), name)
  }
})

test("the composition is self-contained, and every title is real text in it, hidden ones included", (t) => {
  const job = jobFor(t)
  const project = writeDeckProject(releaseDeck(), job)
  const html = readFileSync(join(project.dir, "index.html"), "utf8")

  assert.equal(html.includes("http://"), false, "a deck runs with the network unshared, so no plain http is allowed")
  assert.equal(html.includes("https://"), false, "a deck runs with the network unshared, so no https is allowed")
  assert.equal(/<script\s+src=/i.test(html), false, "every script is inline")

  for (const title of ["Opening the release", "What shipped", "Next steps", "Thank you", "Closing"]) {
    assert.ok(html.includes(title), `the reader of the page must see ${title}`)
  }
  // The hidden slide is kept where a person can find it, without becoming a scene.
  assert.ok(html.includes("Plan B"))
  assert.ok(html.includes('data-slide-id="hidden-plan"'))
  assert.equal(html.includes('data-composition-id="hidden-plan"'), false)

  // The island is the shape the player reads: a scene id per main slide and the branch as its own sequence.
  assert.ok(html.includes('"sceneId": "opening"'))
  assert.ok(html.includes('"label": "Under the hood"'))
})

test("a slide id that could leave the job, or an absolute asset, is refused before anything is written", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mm-deck-refuse-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const job = join(root, "job")
  mkdirSync(job)
  const spec = releaseDeck()

  const escaped = { ...spec, slides: [{ id: "../escape" }, ...spec.slides.slice(1)] } as unknown as DeckSpec
  assert.throws(() => writeDeckProject(escaped, job), /not a safe scene id/)

  const quoted = { ...spec, slides: [{ id: 's"1' }, ...spec.slides.slice(1)] } as unknown as DeckSpec
  assert.throws(() => writeDeckProject(quoted, job), /not a safe scene id/)

  const absolute = { ...spec, slides: [{ ...spec.slides[0]!, asset: "/etc/passwd" }] } as unknown as DeckSpec
  assert.throws(() => writeDeckProject(absolute, job), /is absolute/)

  const climbing = { ...spec, slides: [{ ...spec.slides[0]!, asset: "assets/../../etc/passwd" }] } as unknown as DeckSpec
  assert.throws(() => writeDeckProject(climbing, job), /"\.\." segment/)

  const unknownTarget = {
    ...spec,
    slides: [{ ...spec.slides[0]!, hotspots: [{ id: "more", label: "More", target: "nowhere" }] }],
  } as unknown as DeckSpec
  assert.throws(() => writeDeckProject(unknownTarget, job), /names no branch/)

  // A refusal is a refusal: no file in the job, nothing beside it, and the job itself was the only entry the test made.
  assert.deepEqual(readdirSync(job), [])
  assert.deepEqual(readdirSync(root), ["job"])
})

test("the generated project passes hyperframes check through the real runner", async (t) => {
  const job = jobFor(t)
  writeDeckProject(releaseDeck(), job)

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const check = await deckCheck(runner, job)
  if (!check.ok) {
    if (engineMissing(check.refused)) return t.skip(`no HyperFrames through the runner here: ${check.refused ?? ""}`)
    const limitation = browserHostLimitation(check)
    if (limitation) return t.skip(limitation)
    assert.fail(`the generated project did not pass hyperframes check: ${check.output}`)
  }

  const report = check.report as Record<string, unknown>
  // The envelope's own verdict, not the exit code's: `ok` is what says the deck is ready.
  assert.equal(report["ok"], true)
  assert.equal(report["browserSkipped"], false)
  for (const key of ["lint", "runtime", "layout", "motion", "contrast", "craft", "audio", "hdr", "snapshots", "saved", "_meta"]) {
    assert.ok(key in report, `the check envelope must carry ${key}`)
  }

  // The real runner, not a fake: it made the job's home and temp, and the report it saved is inside the job.
  assert.ok(existsSync(join(job, ".home")), "the runner's HOME is in the job")
  assert.ok(existsSync(join(job, ".tmp")), "the runner's TMPDIR is in the job")
  const saved = report["saved"] as Record<string, unknown>
  assert.ok(existsSync(String(saved["report"])), `the report must be on disk: ${String(saved["report"])}`)
})

test("the project snapshots to five non-empty frames", async (t) => {
  const job = jobFor(t)
  writeDeckProject(releaseDeck(), job)

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  // Snapshot starts a browser too, and on a host where one cannot start it waits for its own 30 s timeout. The check is
  // the short proof that the browser can run at all, so a host limitation skips here before that wait.
  const probe = await deckCheck(runner, job)
  if (!probe.ok) {
    if (engineMissing(probe.refused)) return t.skip(`no HyperFrames through the runner here: ${probe.refused ?? ""}`)
    const limitation = browserHostLimitation(probe)
    if (limitation) return t.skip(limitation)
    assert.fail(`the project could not be checked before snapshotting: ${probe.output}`)
  }

  const snapshot = await deckSnapshot(runner, job)
  assert.equal(snapshot.shots.length, 5, snapshot.output)
  for (const shot of snapshot.shots) {
    assert.ok(resolve(shot).startsWith(resolve(job)), `every shot is inside the job: ${shot}`)
    assert.ok(existsSync(shot), shot)
    assert.ok(statSync(shot).size > 0, `${shot} is not empty`)
  }
})

test("the presenter serves the island, and cancelling the run closes the port", async (t) => {
  const job = jobFor(t)
  writeDeckProject(releaseDeck(), job)

  // A presenter is a local HTTP server the user's browser has to reach. That is the one declaration a deck makes with
  // the network shared; its check and snapshot runs stay under `network: false`.
  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: true, env: [...DECK_ENV_NAMES] })
  const port = await freePort()
  const present = await deckPresent(runner, job, port)
  if (!present.started) {
    if (engineMissing(present.output)) return t.skip(`no HyperFrames through the runner here: ${present.output}`)
    assert.fail(`the presenter did not start: ${present.output}`)
  }

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
    assert.equal(page.status, 200)
    const body = await page.text()
    // The page the CLI builds carries the island it read from the project: the scene ids, the hotspot's label and the
    // branch's label are proof that the manifest reached the slideshow. The titles live in the composition, which the
    // player loads from the same server.
    assert.ok(body.includes('"sceneId": "opening"'), "the island reached the page")
    assert.ok(body.includes('"label": "The details"'), "the hotspot survived into the page")
    assert.ok(body.includes('"label": "Under the hood"'), "the branch survived into the page")
    assert.ok(body.includes('"notes": "say it slowly"'), "the note survived into the page")

    const composition = await fetch(`http://127.0.0.1:${port}/composition/index.html`, {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(composition.status, 200)
    const compositionHtml = await composition.text()
    for (const title of ["Opening the release", "What shipped", "Next steps", "Thank you", "Closing"]) {
      assert.ok(compositionHtml.includes(title), `the presented composition must contain ${title}`)
    }
  } finally {
    // The runner is one-run-at-a-time by design: the presenter holds it until this line, and the port is how the rest of
    // the world sees that it is gone.
    runner.cancel()
  }

  assert.equal(await portClosed(port), true, "cancel() must stop the presenter")
})

test("a refused check is a result with the sentence, not a throw", async (t) => {
  const job = jobFor(t)
  const refused = fakeRunner({
    ...failed(-1),
    refused: 'executable "hyperframes" is not on this adapter\'s allowlist (node)',
  })
  const check = await deckCheck(refused, job)
  assert.equal(check.ok, false)
  assert.equal(check.report, undefined)
  assert.equal(check.refused, 'executable "hyperframes" is not on this adapter\'s allowlist (node)')
  assert.ok(check.output.length > 0 || check.refused.length > 0)

  // An exit zero with a banner instead of an envelope is not a pass either: the report is what a check must return.
  const unreadable = fakeRunner(passed("hyperframes check: all good\n"))
  const broken = await deckCheck(unreadable, job)
  assert.equal(broken.ok, false)
  assert.match(broken.refused ?? "", /no JSON envelope/)
})

test("a snapshot asks for the moments it was given and returns the paths it is told", async (t) => {
  const job = jobFor(t)
  const runner = fakeRunner(passed(JSON.stringify({ ok: true, frames: [{ path: "/job/shot-1.png", time: 1 }] })))
  const snapshot = await deckSnapshot(runner, job, { at: [1, 2.5] })

  assert.deepEqual(runner.calls[0]?.args, ["snapshot", "--json", "--no-browser-gpu", "--at", "1,2.5"])
  assert.deepEqual(snapshot.shots, ["/job/shot-1.png"])
})

test("a presenter that is refused never reports started", async (t) => {
  const job = jobFor(t)
  const runner = fakeRunner({ ...failed(-1), refused: "executable \"hyperframes\" is not on this adapter's allowlist" })
  const present = await deckPresent(runner, job, 41999)
  assert.equal(present.started, false)
  assert.ok(present.output.includes("allowlist"), present.output)
})

test("the deck tells HyperFrames it is inside a sandbox, so Chrome stops building a second one", async (t) => {
  const job = mkdtempSync(join(tmpdir(), "mm-deck-env-"))
  t.after(() => rmSync(job, { recursive: true, force: true }))
  const calls: HostRunInput[] = []
  const fake: HostRunner = {
    async run(input) {
      calls.push(input)
      return { passed: true, code: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false, truncated: false }
    },
    cancel() {},
  }
  await deckCheck(fake, job)
  const check = calls.find((call) => call.args[0] === "check")
  assert.ok(check, "the check ran")
  // Without this the child aborts with `FATAL: No usable sandbox!` inside bubblewrap: HyperFrames looks for a container
  // marker that bwrap does not leave, so the deck has to say it. The value is the adapter's, not the host's.
  assert.deepEqual(check.env, { HYPERFRAMES_CHROME_SANDBOX: "0" })
  assert.ok((deckAdapter().env ?? []).includes("HYPERFRAMES_CHROME_SANDBOX"), "the adapter declares the name it sets")
})

test("the deck adapter never names the program's video encoding command", async (t) => {
  // A deck is presented and snapshotted. A project that was encoded to a video would be a different artifact, and the
  // adapter is the place that decides which of the two a deck is. The interface's own `render` step is the name of "write
  // the artifact's files", so the rule is about the argv the engine is handed: no run the deck makes may ask for the
  // encoder. The argv is the fact; a source grep alone would pass on a command built from a variable.
  const job = mkdtempSync(join(tmpdir(), "mm-deck-render-"))
  t.after(() => rmSync(job, { recursive: true, force: true }))
  const runner = fakeRunner(
    passed(JSON.stringify({ ok: true, lint: {}, runtime: {}, layout: {}, contrast: {} })),
    passed(JSON.stringify({ ok: true, frames: [] })),
  )
  await deckCheck(runner, job)
  await deckSnapshot(runner, job, { at: [0], end: false })
  assert.ok(runner.calls.length >= 2, "the check and the snapshot are what a deck runs")
  for (const call of runner.calls) {
    assert.equal(call.args.includes("render"), false, `a deck asked the engine for: ${call.args.join(" ")}`)
  }

  // The source half, so a later edit cannot reintroduce the word as a literal the current test never reaches.
  const source = readFileSync(new URL("../packages/artifact/src/adapters/deck.ts", import.meta.url), "utf8")
  assert.equal(/\bargs:\s*\[[^\]]*"render"/.test(source), false, "a deck must never call the encoder")
})

// ---------------------------------------------------------------------------------------------------------------------
// Asset slots (B3-T6). A plan names pictures before anything has drawn them, so the project has to be honest about a
// file that is not there: a labelled box a check can accept and name, never a silent gap and never a broken image.

test("a missing asset is a labelled placeholder a check can name, and a real one stays an image", (t) => {
  const job = jobFor(t)
  mkdirSync(join(job, "assets"))
  writeFileSync(join(job, "assets", "hero.png"), "a few bytes standing in for a picture")
  mkdirSync(join(job, "assets", "gallery"))

  const project = writeDeckProject(
    deckOf([
      { id: "s1", title: "Here", asset: "assets/hero.png" },
      { id: "s2", title: "Gone", asset: "assets/absent.png" },
      { id: "s3", title: "Folder", asset: "assets/gallery" },
    ]),
    job,
  )
  const html = readFileSync(join(project.dir, "index.html"), "utf8")

  // The file that exists keeps the element the project has always written.
  assert.ok(html.includes('<img class="asset" src="assets/hero.png"'), "a real asset stays an image")
  // A missing one is not an img with a dead src: it is a box that says what is missing.
  assert.equal(html.includes('src="assets/absent.png"'), false, "a missing asset must not become a broken image")
  assert.equal(html.includes('src="assets/gallery"'), false, "a directory is not an image either")
  assert.ok(html.includes('data-deck-placeholder="assets/absent.png"'), "the check addresses the missing slot by path")
  assert.ok(html.includes("missing asset: assets/absent.png"), "the slide says which picture is missing")
  assert.ok(html.includes('data-deck-placeholder="assets/gallery"'))

  assert.deepEqual(project.placeholders, [
    { slide: "s2", asset: "assets/absent.png", why: "missing" },
    { slide: "s3", asset: "assets/gallery", why: "not a file" },
  ])
  const note = placeholderNote(project)
  assert.match(note ?? "", /^2 placeholders: /)
  assert.ok(note?.includes("assets/absent.png (missing)"), note)
  assert.ok(note?.includes("assets/gallery (not a file)"), note)

  // A placeholder imports nothing: the page is still one file with every script inline.
  assert.equal(html.includes("http://"), false)
  assert.equal(html.includes("https://"), false)
  assert.equal(/<script\s+src=/i.test(html), false)
})

test("an asset link that leaves the job is refused by name, and no project is written", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mm-deck-asset-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const job = join(root, "job")
  mkdirSync(job)
  writeFileSync(join(root, "outside.png"), "a picture from somewhere else")
  symlinkSync(join(root, "outside.png"), join(job, "escape.png"))

  // spec.ts refused the text of a path that climbs out; this is the same rule on the file the text names.
  assert.throws(
    () => writeDeckProject(deckOf([{ id: "s1", asset: "escape.png" }]), job),
    /slide "s1": asset "escape\.png" resolves outside the job directory/,
  )
  for (const name of ["index.html", "hyperframes.json", "meta.json"]) {
    assert.equal(existsSync(join(job, name)), false, `${name} must not exist after a refusal`)
  }
  assert.deepEqual(readdirSync(job), ["escape.png"], "the refusal wrote nothing beside the link the test made")
})

test("an asset past the cap is a placeholder, and the report says why", (t) => {
  const job = jobFor(t)
  mkdirSync(join(job, "assets"))
  writeFileSync(join(job, "assets", "big.png"), "0123456789")

  // The cap is a parameter so the failure costs ten bytes instead of 32 MiB; production uses the exported default.
  assert.equal(MAX_ASSET_BYTES, 32 * 1024 * 1024)
  const project = writeDeckProject(deckOf([{ id: "s1", title: "Big", asset: "assets/big.png" }]), job, {
    maxAssetBytes: 4,
  })
  const html = readFileSync(join(project.dir, "index.html"), "utf8")

  assert.deepEqual(project.placeholders, [{ slide: "s1", asset: "assets/big.png", why: "too large" }])
  assert.ok(html.includes('data-deck-placeholder="assets/big.png"'))
  assert.ok(html.includes("missing asset: assets/big.png"), "the page is the same box; the reason travels in the report")
  assert.ok(placeholderNote(project)?.includes("assets/big.png (too large)"))
})

test("a deck with no asset slots has no placeholders and nothing to report", (t) => {
  const project = writeDeckProject(releaseDeck(), jobFor(t))
  assert.deepEqual(project.placeholders, [])
  assert.equal(placeholderNote(project), undefined)
})

test("a hidden slide's missing asset is a placeholder too, though it is not a scene", (t) => {
  const job = jobFor(t)
  const project = writeDeckProject(
    deckOf([
      { id: "shown", title: "Shown" },
      { id: "plan-b", title: "Plan B", hidden: true, asset: "assets/plan-b.png" },
    ]),
    job,
  )
  const html = readFileSync(join(project.dir, "index.html"), "utf8")
  const hidden = html.slice(html.indexOf('id="hidden-plan-b"'))

  assert.ok(hidden.slice(0, hidden.indexOf("</section>")).includes('data-deck-placeholder="assets/plan-b.png"'))
  // Hidden means "not on the stage", not "not in the file": the check still has to know the picture is absent.
  assert.equal(html.includes('data-composition-id="plan-b"'), false)
  assert.deepEqual(project.placeholders, [{ slide: "plan-b", asset: "assets/plan-b.png", why: "missing" }])
})

// ---------------------------------------------------------------------------------------------------------------------
// The deck's checks (B3-T4). A rule that reads only the spec and the project is tested as a value — a wrong island is a
// wrong island, and no browser should be needed to say so. A rule that reads the page goes through the real engine,
// because a hand-written envelope would only prove that this file can read its own fixture.

// One result by id, with a message that names the id when the definition was not answered at all.
const resultOf = (results: readonly CheckResult[], id: string): CheckResult => {
  const found = results.find((result) => result.id === id)
  assert.ok(found, `the results must carry ${id}`)
  return found
}

// The definitions the adapter itself produces. `deck.contract` is the spec parse's (L0, run: "spec"), so the gate runs it
// before an adapter is handed anything; `checkPlan` is what slices the registry that way.
const GATE_CHECKS = [...CONTRACT_CHECKS.filter((def) => def.kind === "deck"), ...DECK_CHECKS]
const ADAPTER_CHECKS = DECK_CHECKS.filter((def) => def.run === "argv")

interface AdapterHarness {
  readonly ctx: AdapterContext
  readonly logs: string[]
}

const harnessFor = (jobDir: string, run: HostRunner): AdapterHarness => {
  const logs: string[] = []
  const ctx: AdapterContext = { jobDir, specPath: join(jobDir, "deck.json"), run, log: (line) => logs.push(line) }
  return { ctx, logs }
}

// A deck every check can pass: five visible slides, a note on each, a hotspot into a branch of one slide, and no assets.
// It is the deck the acceptance test presents, so a rule that fails on it is a rule a real deck would trip over.
const talkDeck = (): DeckSpec => {
  const parsed = parseSpec("deck", {
    kind: "deck",
    version: 2,
    job: "talk",
    brief: "a deck about the release",
    slides: [
      { id: "opening", title: "Opening the release", body: "what this deck is about", notes: "say it slowly" },
      { id: "shipped", title: "What shipped", body: "three things that changed", notes: "the three points" },
      {
        id: "next",
        title: "Next steps",
        body: "what comes after",
        notes: "the plan",
        hotspots: [{ id: "more", label: "The details", target: "details" }],
      },
      { id: "thanks", title: "Thank you", body: "questions", notes: "ask the room" },
      { id: "closing", title: "Closing", body: "the end", notes: "say goodbye" },
    ],
    branches: [
      { id: "details", label: "Under the hood", slides: [{ id: "how", title: "How it works", body: "the mechanism" }] },
    ],
  })
  assert.ok(parsed.spec, `the deck fixture must parse: ${parsed.errors.join("; ")}`)
  return parsed.spec as DeckSpec
}

interface IslandSlideShape {
  readonly sceneId: string
  readonly hotspots?: readonly { readonly id: string; readonly target: string }[]
}

// A project with its island replaced, which is how a rule about a broken island is tested: `writeDeckProject` refuses a
// spec whose hotspot names no branch, so the only way to reach that state is a project that was tampered with after it
// was written — a person editing the JSON, or a bug in the writer.
const withIsland = (project: DeckProject, slides: readonly unknown[]): DeckProject => ({
  ...project,
  island: { ...project.island, slides },
})

const islandSlidesOf = (project: DeckProject): readonly IslandSlideShape[] =>
  project.island.slides as readonly IslandSlideShape[]

test("the deck's checks are a registry, and the deck adapter is an adapter", () => {
  assertRegistry(DECK_CHECKS)

  const ids = DECK_CHECKS.map((def) => def.id)
  assert.equal(ids.length, 11)
  // The contract check is the gate's: the parse produces it, so it lives in CONTRACT_CHECKS and not in what this adapter
  // claims to produce. A registry that carried it would make the adapter answer for an L0 it never runs.
  assert.equal(ids.includes("deck.contract"), false, "the adapter's registry is what the adapter produces")
  assert.ok(CONTRACT_CHECKS.some((def) => def.id === "deck.contract" && def.kind === "deck"), "the gate still has it")
  for (const id of [
    "deck.slides",
    "deck.notes",
    "deck.links",
    "deck.branch",
    "deck.assets",
    "deck.overflow",
    "deck.contrast",
    "deck.runtime",
    "deck.snapshot",
    "deck.blank",
    "deck.vlm",
  ]) {
    assert.ok(ids.includes(id), `the registry must carry ${id}`)
    assert.equal(DECK_CHECKS.find((def) => def.id === id)?.required, true, `${id} is required`)
  }

  const adapter = deckAdapter()
  assertAdapter(adapter)
  assert.equal(adapter.kind, "deck")
  assert.equal(adapter.name, "hyperframes")
  assert.equal(adapter.version, "0.1.0")
  assert.deepEqual(adapter.executables, ["hyperframes"])
  // The network is the presenter's permission; the check and the snapshot do not ask for it.
  assert.equal(adapter.network, true)
  for (const step of ["prepare", "render", "snapshot", "check", "openEditor", "cancel"]) {
    assert.equal(typeof adapter[step as "prepare"], "function", `${step} must exist`)
  }
})

test("prepare asks for the engine before it writes, and a refusal leaves the job empty", async (t) => {
  const job = jobFor(t)
  const runner = fakeRunner({
    ...failed(-1),
    refused: 'executable "hyperframes" is not on this adapter\'s allowlist (node)',
  })
  const { ctx } = harnessFor(job, runner)

  await assert.rejects(deckAdapter().prepare(releaseDeck(), ctx), (error: Error) => {
    assert.ok(error.message.includes(HYPERFRAMES_INSTALL), error.message)
    assert.ok(error.message.includes("not on this adapter's allowlist"), error.message)
    return true
  })
  // The order is the point: a machine that cannot make a deck leaves no half a deck behind.
  assert.deepEqual(readdirSync(job), [])
  // The version is the gate and is asked first; the doctor pass after it is the diagnosis the reason carries.
  assert.deepEqual(runner.calls[0]?.args, ["--version"])
})

test("a clean five-slide deck goes through prepare, render, snapshot and check, and only the vision review is skipped", async (t) => {
  const job = jobFor(t)
  const spec = talkDeck()
  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const { ctx, logs } = harnessFor(job, runner)
  const adapter = deckAdapter()

  let prepared: { readonly notes?: readonly string[] }
  try {
    prepared = await adapter.prepare(spec, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (engineMissing(message)) return t.skip(`no HyperFrames through the runner here: ${message}`)
    throw error
  }
  assert.match(prepared.notes?.[0] ?? "", /^HyperFrames \d+\.\d+\.\d+/, "the notes name the engine and its version")
  assert.equal(prepared.notes?.length, 1, "a deck with no placeholders has no placeholder note")

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["index.html", "hyperframes.json", "meta.json"])

  const snapshot = await adapter.snapshot(ctx)
  if (snapshot.shots.length !== 5) {
    // A frame count that is not the deck's is a host limitation only when the browser could not start at all; anything
    // else is this code, and the test must fail rather than skip over it.
    const probe = await deckCheck(runner, job)
    if (engineMissing(probe.refused)) return t.skip(`no HyperFrames through the runner here: ${probe.refused ?? ""}`)
    const limitation = browserHostLimitation(probe)
    if (limitation) return t.skip(limitation)
    assert.fail(`the project did not snapshot to five frames: ${snapshot.shots.length}\n${logs.join("\n")}`)
  }
  assert.deepEqual(
    snapshot.shots.map((shot) => shot.label),
    ["opening", "shipped", "next", "thanks", "closing"],
    "one frame per visible slide, named by the slide",
  )
  for (const shot of snapshot.shots) {
    assert.equal(shot.path.startsWith(job), false, `a shot is job-relative: ${shot.path}`)
    assert.ok(existsSync(join(job, shot.path)), `the shot the adapter returns exists: ${shot.path}`)
  }

  const results = await adapter.check(ctx, ADAPTER_CHECKS)
  const coverage = evaluate(ADAPTER_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(coverage.missing, [])
  assert.deepEqual(coverage.failed, [], coverage.failed.map((result) => `${result.id}: ${result.reason ?? ""}`).join("; "))
  assert.equal(coverage.ok, true)

  const vlm = resultOf(results, "deck.vlm")
  assert.equal(vlm.status, "skipped")
  assert.equal(vlm.code, SKIPPED_CODE)
  assert.equal(vlm.reason, "no local vision model is configured, and a cloud model is not called for a deck check (D13/D21)")
  for (const def of ADAPTER_CHECKS) {
    if (def.id === "deck.vlm") continue
    const result = resultOf(results, def.id)
    assert.equal(result.status, "passed", `${def.id}: ${result.reason ?? result.output ?? ""}`)
  }

  // The two rules that only the adapter can answer, in the sentences a reader gets.
  assert.equal(resultOf(results, "deck.snapshot").output, "5 frames for 5 slides")
  assert.equal(resultOf(results, "deck.runtime").output, "the page ran with no console error")
})

test("a slide with no title, body or asset snaps to a blank frame, and the check names the file", async (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "empty", notes: "nothing on it" }])
  const project = writeDeckProject(spec, job)

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const snapshot = await deckSnapshot(runner, job, { at: [0], end: false })
  if (snapshot.shots.length !== 1) {
    if (engineMissing(snapshot.output) || snapshot.output.includes("EACCES")) {
      return t.skip(`no browser through the runner here: ${snapshot.output.trim()}`)
    }
    assert.fail(`the empty slide did not snapshot: ${snapshot.output}`)
  }

  const blank = resultOf(deckResults({ spec, project, shots: snapshot.shots }, DECK_CHECKS), "deck.blank")
  assert.equal(blank.status, "failed")
  // The file and the share: the reader has to know which frame to look at and how empty it was.
  assert.match(blank.reason ?? "", /frame-00-at-0s\.png/)
  assert.match(blank.reason ?? "", /\d+\.\d% of the frame/)
})

test("a page that throws fails the runtime check with the message, and the same deck without the script passes", async (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "one", title: "One", body: "first", notes: "a note" }])
  const project = writeDeckProject(spec, job)
  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })

  // The deck as the writer made it: nothing on the page throws.
  const clean = await deckCheck(runner, job)
  if (!clean.ok) {
    if (engineMissing(clean.refused)) return t.skip(`no HyperFrames through the runner here: ${clean.refused ?? ""}`)
    const limitation = browserHostLimitation(clean)
    if (limitation) return t.skip(limitation)
    assert.fail(`the clean project did not check: ${clean.output}`)
  }
  const cleanRuntime = resultOf(deckResults({ spec, project, report: clean.report }, DECK_CHECKS), "deck.runtime")
  assert.equal(cleanRuntime.status, "passed")

  // The writer escapes the body, so a throwing script cannot arrive through the spec: the test edits the page the way a
  // person would, which is also the only way the browser sees a script the writer never wrote.
  appendFileSync(join(job, "index.html"), '<script>throw new Error("boom")</script>\n')
  const broken = await deckCheck(runner, job)
  assert.equal(broken.ok, false, "a page that throws is not a deck that passes")
  const runtime = resultOf(deckResults({ spec, project, report: broken.report }, DECK_CHECKS), "deck.runtime")
  assert.equal(runtime.status, "failed")
  assert.match(runtime.reason ?? "", /boom/)
})

test("a body that cannot be laid out on the slide fails the overflow check", async (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "one", title: "One", body: "first", notes: "a note" }])
  const project = writeDeckProject(spec, job)

  // The body the writer would escape is replaced by a long unbroken token at a size that cannot fit the box. A real
  // author reaches this through a bare URL or an id with no spaces, so the input is what a deck can contain.
  const page = readFileSync(join(job, "index.html"), "utf8")
  writeFileSync(join(job, "index.html"), page.replace("<p>first</p>", `<p style="font-size:64px">${"X".repeat(400)}</p>`))

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const check = await deckCheck(runner, job)
  if (!check.ok) {
    if (engineMissing(check.refused)) return t.skip(`no HyperFrames through the runner here: ${check.refused ?? ""}`)
    const limitation = browserHostLimitation(check)
    if (limitation) return t.skip(limitation)
    // A check whose only failure is the overflow this test made is the expected envelope; anything else is a fixture bug.
    const layout = check.report as { layout?: { findings?: readonly { code: string }[] } } | undefined
    const overflow = (layout?.layout?.findings ?? []).filter((finding) => /overflow|overlap/.test(finding.code))
    assert.ok(overflow.length > 0, `the patched page produced no overflow finding: ${check.output}`)
  }

  const result = resultOf(deckResults({ spec, project, report: check.report }, DECK_CHECKS), "deck.overflow")
  assert.equal(result.status, "failed")
  // The sentence is the engine's: the box it names and what the text did.
  assert.match(result.reason ?? "", /#slide-one/)
  assert.match(result.reason ?? "", /outside|overflow|overlap/i)
})

test("text at #777 on #808080 fails the contrast check, and the count and the first pair are named", async (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "one", title: "One", body: "first", notes: "a note" }])
  const project = writeDeckProject(spec, job)

  // The generator has its own palette and the spec carries no colour, so the test patches the project's custom properties
  // — the same edit a theme would make, and the reason the contrast pass has to look at pixels rather than at the spec.
  const page = readFileSync(join(job, "index.html"), "utf8")
  writeFileSync(
    join(job, "index.html"),
    page
      .replace("--ground: #101014;", "--ground: #808080;")
      .replace("--ink: #f5f5f7;", "--ink: #777777;")
      .replace("--muted: #b9b9c2;", "--muted: #777777;"),
  )

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const check = await deckCheck(runner, job)
  if (!check.ok) {
    if (engineMissing(check.refused)) return t.skip(`no HyperFrames through the runner here: ${check.refused ?? ""}`)
    const limitation = browserHostLimitation(check)
    if (limitation) return t.skip(limitation)
    const contrast = check.report as { contrast?: { findings?: readonly { code: string }[] } } | undefined
    assert.ok(
      (contrast?.contrast?.findings ?? []).length > 0,
      `the grey-on-grey page produced no contrast finding: ${check.output}`,
    )
  }

  const result = resultOf(deckResults({ spec, project, report: check.report }, DECK_CHECKS), "deck.contrast")
  assert.equal(result.status, "failed")
  assert.match(result.reason ?? "", /WCAG/)
  assert.match(result.reason ?? "", /Contrast is/)
})

test("a slide that points at a file which is not there fails the links check", async (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "one", title: "One", body: "first", notes: "a note" }])
  const project = writeDeckProject(spec, job)

  // The writer resolves a slide's `asset` before it writes, so a missing picture becomes a placeholder and never a broken
  // reference. A hand-written `<img>` in the page is the way a reference goes missing, and it is what the lint scan looks
  // for: the row it reports is `missing_local_asset`.
  const page = readFileSync(join(job, "index.html"), "utf8")
  writeFileSync(join(job, "index.html"), page.replace("<p>first</p>", '<p>first</p><img src="gone.png" alt="" />'))

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const check = await deckCheck(runner, job)
  if (!check.ok) {
    if (engineMissing(check.refused)) return t.skip(`no HyperFrames through the runner here: ${check.refused ?? ""}`)
    const limitation = browserHostLimitation(check)
    if (limitation) return t.skip(limitation)
  }

  const result = resultOf(deckResults({ spec, project, report: check.report }, DECK_CHECKS), "deck.links")
  assert.equal(result.status, "failed")
  assert.match(result.reason ?? "", /gone\.png/)
})

test("an anchor is not a reference the engine resolves, so the link rule is about targets and says so", async (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "one", title: "One", body: "first", notes: "a note" }])
  const project = writeDeckProject(spec, job)

  // This is a fact about HyperFrames 0.9.54, pinned so a later version that grows a link rule cannot slip past silently:
  // a `<a href>` is never fetched, so nothing in the envelope names a dead hyperlink. If this test ever fails, the engine
  // learned something new and `REFERENCE_CODES` has to learn it too.
  const page = readFileSync(join(job, "index.html"), "utf8")
  writeFileSync(join(job, "index.html"), page.replace("<p>first</p>", '<p>first</p><p><a href="missing.html">details</a></p>'))

  const runner = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: false, env: [...DECK_ENV_NAMES] })
  const check = await deckCheck(runner, job)
  if (!check.ok) {
    if (engineMissing(check.refused)) return t.skip(`no HyperFrames through the runner here: ${check.refused ?? ""}`)
    const limitation = browserHostLimitation(check)
    if (limitation) return t.skip(limitation)
  }

  const report = check.report as { lint?: { findings?: readonly { code: string; message: string }[] } } | undefined
  const mentions = (report?.lint?.findings ?? []).filter((finding) => finding.message.includes("missing.html"))
  assert.deepEqual(mentions, [], "the lint pass reports no anchor, which is why the link rule cannot be about one")
  assert.equal(resultOf(deckResults({ spec, project, report: check.report }, DECK_CHECKS), "deck.links").status, "passed")
})

test("a slide with no notes fails the notes check, which names the slide", (t) => {
  const job = jobFor(t)
  const spec = deckOf([
    { id: "spoken", title: "Spoken", notes: "here" },
    { id: "silent", title: "Silent" },
  ])
  const project = writeDeckProject(spec, job)

  const result = resultOf(deckResults({ spec, project }, DECK_CHECKS), "deck.notes")
  assert.equal(result.status, "failed")
  assert.match(result.reason ?? "", /silent/)
  assert.equal((result.reason ?? "").includes("spoken"), false, "the slide that has notes is not named")
})

test("a hotspot that names no branch fails the branch check, which names the hotspot", (t) => {
  const job = jobFor(t)
  const spec = releaseDeck()
  const project = writeDeckProject(spec, job)
  const slides = islandSlidesOf(project)
  const tampered = withIsland(
    project,
    slides.map((slide) => ({
      ...slide,
      hotspots: (slide.hotspots ?? []).map((hotspot) => ({ ...hotspot, target: "nowhere" })),
    })),
  )

  const result = resultOf(deckResults({ spec, project: tampered }, DECK_CHECKS), "deck.branch")
  assert.equal(result.status, "failed")
  assert.match(result.reason ?? "", /hotspot "more"/)
  assert.match(result.reason ?? "", /"nowhere"/)
})

test("a missing asset is a placeholder the assets check accepts and names, and a silent one is a failure", (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "s1", title: "Here", asset: "assets/hero.png", notes: "a note" }])
  const project = writeDeckProject(spec, job)

  const result = resultOf(deckResults({ spec, project }, DECK_CHECKS), "deck.assets")
  assert.equal(result.status, "passed")
  assert.equal(result.output, placeholderNote(project))
  assert.match(result.output ?? "", /1 placeholder: assets\/hero\.png \(missing\)/)

  // A placeholder nothing can name is the silent case the rule exists to refuse: it is a failure, not a pass.
  const silent: DeckProject = { ...project, placeholders: [{ slide: "", asset: "", why: "missing" }] }
  assert.equal(resultOf(deckResults({ spec, project: silent }, DECK_CHECKS), "deck.assets").status, "failed")
})

// A 16-bit greyscale PNG: the header a decoder reads before the pixels, which is as far as this reader has to go to
// refuse it. The chunks are real — a wrong IHDR checksum would be a different refusal ("the header does not match its
// checksum") and this test is about the bit depth.
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

const sixteenBitPng = (): Buffer => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 16 // bit depth
  header[9] = 0 // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.alloc(2 * (2 * 2 + 1))),
    pngChunk("IEND", new Uint8Array()),
  ])
}

test("a 16-bit frame skips the blank check with the reader's reason instead of failing it", (t) => {
  const job = jobFor(t)
  const spec = deckOf([{ id: "one", title: "One", notes: "a note" }])
  const project = writeDeckProject(spec, job)
  const shot = join(job, "sixteen-bit.png")
  writeFileSync(shot, sixteenBitPng())

  const result = resultOf(deckResults({ spec, project, shots: [shot] }, DECK_CHECKS), "deck.blank")
  assert.equal(result.status, "skipped")
  assert.equal(result.code, SKIPPED_CODE)
  assert.match(result.reason ?? "", /16/)
  assert.match(result.reason ?? "", /bit depth/)
})

test("an island that names a scene the project lacks fails the slides check, which names it", (t) => {
  const job = jobFor(t)
  const spec = deckOf([
    { id: "one", notes: "a note" },
    { id: "two", notes: "another" },
  ])
  const project = writeDeckProject(spec, job)
  const tampered = withIsland(
    project,
    islandSlidesOf(project).map((slide) => (slide.sceneId === "two" ? { ...slide, sceneId: "ghost" } : slide)),
  )

  const result = resultOf(deckResults({ spec, project: tampered }, DECK_CHECKS), "deck.slides")
  assert.equal(result.status, "failed")
  assert.match(result.reason ?? "", /ghost/)
})

test("check and snapshot ask for deterministic SwiftShader, because a check must see the same pixels everywhere", async (t) => {
  const job = jobFor(t)

  const checked = fakeRunner(passed(JSON.stringify({ ok: true, lint: {}, runtime: {}, layout: {}, contrast: {} })))
  await deckCheck(checked, job)
  const checkArgs = checked.calls[0]?.args ?? []
  assert.equal(checkArgs[0], "check")
  assert.ok(checkArgs.includes("--no-browser-gpu"), `the check must pass --no-browser-gpu: ${checkArgs.join(" ")}`)

  const snapped = fakeRunner(passed(JSON.stringify({ ok: true, frames: [] })))
  await deckSnapshot(snapped, job, { at: [1], end: false })
  const snapshotArgs = snapped.calls[0]?.args ?? []
  assert.equal(snapshotArgs[0], "snapshot")
  assert.ok(snapshotArgs.includes("--no-browser-gpu"), `the snapshot must pass --no-browser-gpu: ${snapshotArgs.join(" ")}`)
  // One frame per slide also means the CLI's extra end-of-timeline frame is off when the caller named every scene.
  assert.ok(snapshotArgs.includes("--no-end"))
})

test("a snapshot that did not cover every slide fails the count check, naming both numbers", (t) => {
  const job = jobFor(t)
  const spec = deckOf([
    { id: "one", title: "One", notes: "a note" },
    { id: "two", title: "Two", notes: "another" },
  ])
  const project = writeDeckProject(spec, job)

  // The adapter asks for one frame per visible slide; a run that returned fewer is a browser that photographed less than
  // the deck, and the rule is the count, not the frames' contents (deck.blank reads those).
  const result = resultOf(deckResults({ spec, project, shots: ["one.png"] }, DECK_CHECKS), "deck.snapshot")
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "1 frame for 2 slides")

  const none = resultOf(deckResults({ spec, project, shots: [] }, DECK_CHECKS), "deck.snapshot")
  assert.equal(none.status, "failed")
  assert.equal(none.reason, "0 frames for 2 slides")
})

// ---------------------------------------------------------------------------------------------------------------------
// The job's acceptance (B3-T7). §5 B3 asks for "brief → deck → snapshot checks → present, with no `artifactd`, no GPU and
// no other adapter built". The tests below build that sentence out of the real parts: a plan.md rendered by the plugin's
// own renderer, the handoff's spec, the real host runner and the installed engine. Nothing about the engine is faked;
// the one wrapper is a recording runner, which passes every call through and remembers the argv so the test can read it.

interface RecordingRunner extends HostRunner {
  readonly calls: readonly HostRunInput[]
}

const recordingRunner = (inner: HostRunner): RecordingRunner => {
  const calls: HostRunInput[] = []
  return {
    calls,
    async run(input: HostRunInput): Promise<HostRunResult> {
      calls.push(input)
      return inner.run(input)
    },
    cancel(): void {
      inner.cancel()
    },
  }
}

// The L0 result the pipeline produces from the spec parse before an adapter is handed anything (`checkPlan` runs it
// first, and checks.ts gives it to the parse because a program must not grade its own spec). The adapter can only skip
// `deck.contract`, so the acceptance test asks the parse for it the same way a caller does.
const contractResult = (spec: DeckSpec): CheckResult => {
  const parsed = parseSpec("deck", spec)
  return parsed.errors.length === 0
    ? { id: "deck.contract", level: "L0", status: "passed", code: 0, output: "the deck spec parses" }
    : { id: "deck.contract", level: "L0", status: "failed", code: 1, reason: parsed.errors.join("; ") }
}

test("brief → deck → checks → present: a plan's page becomes a deck that checks out and is presented", async (t) => {
  const jobDir = jobFor(t)
  const project = dirname(jobDir)
  const jobId = "job-1"
  const brief = "a deck about the release"
  // The root the spec's paths are relative to, asked for the way a caller asks.
  const root = artifactsRootFor(project, jobId)

  // The promoted page, written where promote.ts writes it and hashed the way plan.md records it.
  const page = "t1/release.html"
  const pageBody = '<!doctype html>\n<html lang="en"><body><h1>What shipped</h1><p>the release, in three parts</p></body></html>\n'
  const promotedPath = join(root, ...page.split("/"))
  mkdirSync(dirname(promotedPath), { recursive: true })
  writeFileSync(promotedPath, pageBody)
  const promotedSha = await sha256File(promotedPath)

  const plan: PlanDoc = {
    goal: brief,
    findings: [],
    decisions: [],
    openQuestions: [],
    tasks: [{ id: "t1", title: "Draft it", role: "worker", files: [], acceptance: [] }],
    artifacts: [{ task: "t1", path: "release.html", bytes: Buffer.byteLength(pageBody), sha256: promotedSha }],
    risks: [],
  }
  const handoff = await specFromPlan({
    planMd: renderPlanDoc({ id: jobId }, plan),
    artifactsRoot: root,
    kind: "deck",
    job: jobId,
    brief,
  })

  // Brief → deck: one promoted page, one slide titled by the page's own heading, at the hash the plan recorded.
  assert.deepEqual(handoff.errors, [])
  assert.deepEqual(handoff.warnings, [])
  const briefed = handoff.spec
  assert.ok(briefed !== undefined && briefed.kind === "deck", "the handoff must produce a deck spec")
  if (!briefed || briefed.kind !== "deck") return
  assert.equal(briefed.job, jobId)
  assert.equal(briefed.brief, brief)
  assert.equal(briefed.version, 2)
  assert.deepEqual(
    briefed.slides.map((slide) => [slide.title, slide.asset]),
    [["What shipped", page]],
  )
  assert.deepEqual(
    handoff.used.map((entry) => [entry.task, entry.path, entry.sha256]),
    [["t1", page, promotedSha]],
  )

  // Speaker notes are authored, not promoted: plan.md's artifact table has no notes column, so a person writes them onto
  // the spec the handoff returned. Without them `deck.notes` fails and the deck does not ship, which is why the
  // acceptance test adds the one line a speaker would.
  const parsed = parseSpec("deck", {
    ...briefed,
    slides: briefed.slides.map((slide) => ({ ...slide, notes: `talk about ${slide.title ?? slide.id}` })),
  })
  assert.deepEqual(parsed.errors, [])
  const spec = parsed.spec
  assert.ok(spec !== undefined && spec.kind === "deck")
  if (!spec || spec.kind !== "deck") return

  // Stage the promoted file into the job under the same relative path: the handoff's asset paths are relative to the
  // artifacts root, and the adapter reads them from the job directory.
  const staged = join(jobDir, ...page.split("/"))
  mkdirSync(dirname(staged), { recursive: true })
  copyFileSync(promotedPath, staged)
  assert.equal(await sha256File(staged), spec.assets?.[0]?.sha256, "the staged bytes are the plan's bytes")

  const adapter = deckAdapter()
  const engine = await hostRunnerFor(adapter, { jobDir })
  const run = recordingRunner(engine)
  const logs: string[] = []
  const ctx: AdapterContext = { jobDir, specPath: join(jobDir, "deck.json"), run, log: (line) => logs.push(line) }

  // Prepare asks the engine before it writes, and the note names the version that made the deck.
  const prepared = await adapter.prepare(spec, ctx)
  const note = prepared.notes?.[0] ?? ""
  const version = /^HyperFrames (\S+) made this deck$/.exec(note)?.[1]
  assert.ok(version !== undefined, `the prepare note names the engine and its version: ${note}`)
  assert.match(version ?? "", /^\d+\.\d+\.\d+/, version)
  assert.equal(prepared.notes?.length, 1, "a deck whose asset is there has no placeholder note")

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["index.html", "hyperframes.json", "meta.json"])
  for (const name of rendered.outputs) assert.ok(existsSync(join(jobDir, name)), name)

  // One frame for the one visible slide, named by it.
  const snapshot = await adapter.snapshot(ctx)
  assert.deepEqual(
    snapshot.shots.map((shot) => shot.label),
    ["t1-release-html"],
  )
  for (const shot of snapshot.shots) {
    assert.ok(existsSync(join(jobDir, shot.path)), `the shot the adapter returns exists: ${shot.path}`)
    assert.ok(statSync(join(jobDir, shot.path)).size > 0, shot.path)
  }

  // The checks. The adapter produces the mechanical and visual results and can only skip the contract, which is the
  // parse's; the parse's result is run here the way the pipeline runs it, and the whole registry is then evaluated.
  const checked = await adapter.check(ctx, DECK_CHECKS)
  const results = [contractResult(spec), ...checked]
  const coverage = evaluate(GATE_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(coverage.missing, [])
  assert.deepEqual(coverage.failed, [])
  assert.equal(coverage.ok, true, "every required deck check must pass")
  assert.deepEqual(
    coverage.skipped.map((result) => result.id),
    ["deck.vlm"],
    "the vision review is the only check that did not run",
  )
  // The snapshot and blank rules are looking at the frame this run actually produced.
  assert.equal(resultOf(results, "deck.snapshot").output, "1 frame for 1 slide")
  assert.equal(resultOf(results, "deck.blank").output, "1 frame all carry content")

  // The record the deck travels with: the engine's row, built from the version prepare reported, round-tripped through
  // the file a reader would open.
  const tool = hyperframesTool(version ?? "")
  assert.equal(tool.name, "hyperframes")
  assert.equal(tool.version, version)
  assert.equal(tool.license, "Apache-2.0")
  assert.equal(tool.territory, "global")
  const provenance = buildProvenance({
    tool,
    inputs: handoff.used.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    spec: { kind: spec.kind, version: spec.version, sha256: specHash(spec) },
    createdAt: "2026-11-16T00:00:00Z",
  })
  await writeProvenance(jobDir, provenance)
  const read = await readProvenance(jobDir)
  assert.deepEqual(read.errors, [])
  assert.deepEqual(read.provenance, provenance)
  assert.equal(read.provenance?.tool.version, version)
  assert.equal(read.provenance?.tool.license, "Apache-2.0")

  // No GPU. `_meta` in the real envelope carries only `version` and `updateAvailable`, so the renderer is not named
  // there; the argv the adapter handed the runner is where the decision is readable, and the recording runner kept it.
  const checkCall = run.calls.find((call) => call.args[0] === "check")
  assert.ok(checkCall !== undefined, "the check ran")
  assert.ok(checkCall.args.includes("--no-browser-gpu"), `the check must ask for SwiftShader: ${checkCall.args.join(" ")}`)
  const snapshotCall = run.calls.find((call) => call.args[0] === "snapshot")
  assert.ok(snapshotCall?.args.includes("--no-browser-gpu"), "the snapshot asks for the same renderer")
  // A check reads a local file, so it narrows the adapter's network declaration to nothing and stays wrapped.
  assert.equal(checkCall.network, undefined, "the check must not ask for the host network")

  // Present: the adapter picks a free port and the run's own argv names it, so the test reads the port from the call it
  // recorded rather than guessing one. Every wait below is bounded: a presenter that never answers fails this test.
  // Both steps are optional on the interface (a headless artifact has no editor); a deck's adapter has them.
  const openEditor = adapter.openEditor
  const cancel = adapter.cancel
  assert.ok(openEditor !== undefined && cancel !== undefined, "a deck presents and can cancel the presenter")
  if (openEditor === undefined || cancel === undefined) return
  await openEditor(ctx)
  const presentCall = run.calls.find((call) => call.args[0] === "present")
  assert.ok(presentCall !== undefined, "the presenter was started")
  const port = Number(presentCall.args[presentCall.args.indexOf("--port") + 1])
  assert.ok(Number.isInteger(port) && port > 0, `the presenter's argv names its port: ${presentCall.args.join(" ")}`)
  assert.equal(presentCall.network, true, "the presenter is the one run that needs the host network")

  try {
    const served = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
    assert.equal(served.status, 200)
    const body = await served.text()
    assert.ok(body.includes('"sceneId": "t1-release-html"'), "the island reached the presented page")
    assert.ok(body.includes('"notes": "talk about What shipped"'), "the speaker note reached the page")
    const composition = await fetch(`http://127.0.0.1:${port}/composition/index.html`, {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(composition.status, 200)
    assert.ok((await composition.text()).includes("What shipped"), "the presented composition carries the slide")
  } finally {
    cancel()
  }
  assert.equal(await portClosed(port), true, "cancel() must stop the presenter")
})

// The last step of the acceptance, kept apart so the rest of it can be green while this one states the defect it finds.
// The results below have exactly the shape the test above asserts a real run produces: every required deck check
// passed, and `deck.vlm` skipped with its reason.
test("the quality gate ships a deck whose only skip is the vision review", () => {
  const spec = talkDeck()
  const noVisionModel = "no local vision model is configured, and a cloud model is not called for a deck check (D13/D21)"
  const results: readonly CheckResult[] = [
    contractResult(spec),
    ...DECK_CHECKS.map(
    (def): CheckResult =>
      def.id === "deck.vlm"
        ? { id: def.id, level: def.level, status: "skipped", code: SKIPPED_CODE, reason: noVisionModel }
        : { id: def.id, level: def.level, status: "passed", code: 0, output: `${def.id} passed` },
    ),
  ]

  const coverage = evaluate(GATE_CHECKS, results)
  assert.equal(coverage.ok, true)
  assert.deepEqual(
    coverage.skipped.map((result) => result.id),
    ["deck.vlm"],
  )

  const gate = qualityGate({ spec, defs: GATE_CHECKS, results })
  assert.equal(
    gate.ship,
    true,
    gate.verdicts
      .filter((verdict) => !verdict.ok)
      .map((verdict) => `${verdict.id}: ${verdict.why}`)
      .join("; "),
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// The two boundaries B3's acceptance names beside the deck itself: no second adapter, and no daemon. They are stated as
// what the tree contains, because that is what "not built" means here.

test("the package builds one adapter per kind and names no artifact daemon or deferred PPTX path (D24)", () => {
  const built = readdirSync(new URL("../packages/artifact/src/adapters/", import.meta.url)).sort()
  // D24: B3 ships the HTML deck only, B2 adds the HyperFrames video adapter and B5 adds the image adapter; a file here
  // outside those producers and their own modules is a third artifact producer that was built without a task, which is
  // the thing the acceptance says did not happen — not that a kind must live in exactly one file.
  const allowed = new Set(["deck.ts", "deck-checks.ts", "deck-project.ts", "deck-run.ts", "hyperframes.ts", "video.ts", "image.ts"])
  assert.deepEqual(built.filter((name) => !allowed.has(name)), [])

  const source = new URL("../packages/artifact/src/", import.meta.url)
  const files = readdirSync(source, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, source), "utf8") }))
  assert.ok(files.length >= 10, "the walk must see the package, not an empty list")
  const offenders = files.filter((file) => /\bartifactd\b|\bpptx\b|pptxgenjs|libreoffice/i.test(file.text))
  assert.deepEqual(
    offenders.map((file) => file.name),
    [],
    "the artifact package must carry neither artifactd nor the deferred PPTX path (D24)",
  )
})

test("the network is the presenter's permission: every other run narrows it away and is wrapped", async (t) => {
  const job = jobFor(t)
  writeDeckProject(deckOf([{ id: "one", title: "One", notes: "a note" }]), job)

  const calls: HostRunInput[] = []
  const fake: HostRunner = {
    async run(input: HostRunInput): Promise<HostRunResult> {
      calls.push(input)
      if (input.args[0] === "present") return { ...failed(-1), cancelled: true }
      if (input.args[0] === "snapshot") return passed(JSON.stringify({ ok: true, frames: [] }))
      return passed(JSON.stringify({ ok: true, lint: {}, runtime: {}, layout: {}, contrast: {} }))
    },
    cancel() {},
  }
  await deckCheck(fake, job)
  await deckSnapshot(fake, job, { at: [0], end: false })
  const present = await deckPresent(fake, job, 41_998)
  assert.equal(present.started, false, "the fake presenter stopped before answering, which is not a start")

  // The adapter declares the permission once; each run has to ask for it, and only the presenter does.
  assert.equal(deckAdapter().network, true)
  const asked = (step: string): HostRunInput | undefined => calls.find((call) => call.args[0] === step)
  assert.equal(asked("check")?.network, undefined, "a check reads a local file and asks for no network")
  assert.equal(asked("snapshot")?.network, undefined, "a snapshot renders a local file and asks for no network")
  assert.equal(asked("present")?.network, true, "the presenter serves a page the user's browser opens")
  assert.equal(
    calls.every((call) => (call.args[0] === "present") === (call.network === true)),
    true,
    "no run may take the network the presenter did not ask for",
  )

  // And the wrapped half is a fact of the runner, not a comment: with the adapter's declaration in place but bubblewrap
  // unavailable, a check is refused rather than run with the host's network. That is what "every check runs wrapped"
  // means for a run that never asked.
  const unwrapped = await createHostRunner({ allow: ["hyperframes"], jobDir: job, network: true, bwrap: false, env: [...DECK_ENV_NAMES] })
  const refused = await deckCheck(unwrapped, job)
  assert.equal(refused.ok, false)
  assert.match(refused.refused ?? "", /is not runnable here, so the program would run with the network/)
})
