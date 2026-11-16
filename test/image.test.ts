// The image spec (B5-T1), its ComfyUI-backed adapter (B5-T2), the checkpoint policy (B5-T4), the deterministic checks
// (B5-T5), the one-render-at-a-time rule (B5-T6) and the cloud shape (B5-T3). The spec tests are pure: a version 2 image
// set parses with a checkpoint it shares and a checkpoint one slot owns, and every way of getting a model, a ref or a
// size wrong fails at the address the reader has to fix. The client tests run against a real HTTP server on loopback
// (fake-comfy.ts) because a timeout, a 500 and a closed port are things a `Response` stub cannot have; each one is a
// value and none is a throw.
//
// The adapter tests are the same shape as the video's: `prepare` is checked against the files it writes, and `render`
// against the files the fake server produced. The fake can fail a job, refuse a checkpoint by name or return bytes that
// are not a picture, because those are the cases where a silent pass would be worse than a red line.
//
// Two things are counted rather than described. A refused checkpoint is checked against the server's request log: an
// unknown hash must leave that log empty, because a workflow that was never written cannot be sent. And one render at a
// time is checked against the number of `/prompt` requests the fake was answering at once (`peakPrompts`), because a
// sequential loop is a property of this code and not of the test's patience.
//
// The registry the adapter reads lives in a temporary state directory per test, so a developer's own models.json cannot
// decide whether these tests pass. The checkpoints these fixtures declare are the ones the code table knows, by their
// published sha256.
//
// The last test reads the package manifests: the client is `fetch` and `WebSocket`, and no dependency was added for a
// WebSocket client, a multipart body or a PNG.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"

import { artifactsRootFor, specFromPlan } from "../packages/micromanager/src/artifact/handoff.ts"
import { renderPlanDoc, type PlanDoc } from "../packages/micromanager/src/plandoc.ts"
import {
  IMAGE_CHECKS,
  imageAdapter,
  imageWorkflow,
  writeImageProject,
  type ImageAdapterOptions,
  type ImageProject,
} from "../packages/artifact/src/adapters/image.ts"
import {
  assertAdapter,
  executablesOf,
  networkOf,
  type AdapterContext,
  type HostRunResult,
} from "../packages/artifact/src/adapter.ts"
import { evaluate, type CheckResult } from "../packages/artifact/src/checks.ts"
import { cloudImageBackend, CLOUD_IMAGE_KEY_ENV } from "../packages/artifact/src/cloud-image.ts"
import { ComfyClient, type ComfyOptions, type ComfyProgress } from "../packages/artifact/src/comfyui.ts"
import {
  MODEL_REGISTRY,
  readModelRegistry,
  registerModel,
  registryWith,
  type ModelRegistry,
} from "../packages/artifact/src/models.ts"
import { encodePng as writePng, readPng } from "../packages/artifact/src/png.ts"
import { manifestOf, sha256File, verifyManifest } from "../packages/artifact/src/provenance.ts"
import { qualityGate } from "../packages/artifact/src/quality.ts"
import { createHostRunner } from "../packages/artifact/src/runner.ts"
import { parseSpec, SPEC_VERSIONS, type ImagesSpec } from "../packages/artifact/src/spec.ts"
import { encodePng, solid } from "./harness.ts"
import { FakeComfy, type FakeComfyOptions } from "./fake-comfy.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.

// The published sha256 of two checkpoints the registry lists: stabilityai's SDXL base 1.0 and black-forest-labs'
// FLUX.1 schnell. They are what makes a fixture allowed without a registration, so these tests are about the adapter
// rather than about a temp file somebody wrote. A typo here fails the run: the table would no longer know the hash.
const SDXL_SHA = "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b"
const FLUX_SHA = "9403429e0052277ac2a87ad800adece5481eecefd9ed334e1f348723621d2a0a"

// A version 2 image set that uses everything B5-T1 added: a checkpoint for the set, a different one for one slot, and
// the seed, negative and refs the contract already had.
const v2 = (): Record<string, unknown> => ({
  kind: "images",
  version: 2,
  job: "job-1",
  brief: "images for the release",
  checks: ["images.contract"],
  model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
  slots: [
    {
      id: "hero",
      prompt: "a calm gradient",
      size: { width: 512, height: 512 },
      seed: 7,
      negative: "text",
      refs: ["refs/a.png"],
    },
    {
      id: "wide",
      prompt: "a wide gradient",
      size: { width: 1024, height: 512 },
      model: { name: "FLUX schnell", file: "flux1-schnell.safetensors", sha256: FLUX_SHA },
    },
  ],
})

const parsed = (value: unknown): ImagesSpec => {
  const answer = parseSpec("images", value)
  assert.ok(answer.spec, `the fixture must parse: ${answer.errors.join("; ")}`)
  return answer.spec as ImagesSpec
}

const noopRunner = {
  async run(): Promise<HostRunResult> {
    return { passed: true, code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }
  },
  cancel(): void {},
}

const jobDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "mm-image-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const context = (dir: string, signal?: AbortSignal): AdapterContext & { readonly logs: string[] } => {
  const logs: string[] = []
  return {
    jobDir: dir,
    specPath: join(dir, "images.json"),
    run: noopRunner,
    log: (line) => logs.push(line),
    ...(signal !== undefined ? { signal } : {}),
    logs,
  }
}

const fakeFor = async (t: TestContext, options: FakeComfyOptions = {}): Promise<FakeComfy> => {
  const fake = await new FakeComfy(options).listen()
  t.after(() => fake.close())
  return fake
}

const clientFor = (fake: FakeComfy, options: Partial<ComfyOptions> = {}): ComfyClient =>
  new ComfyClient({ url: fake.url, pollMs: 10, watchTimeoutMs: 5000, ...options })

// A state directory per test: the adapter reads a models.json from it, and a developer's own file must not be able to
// change what these tests prove.
const stateDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "mm-image-state-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const adapterFor = (t: TestContext, fake: FakeComfy, options: Partial<ImageAdapterOptions> = {}) =>
  imageAdapter({
    comfy: { url: fake.url, pollMs: 5, watchTimeoutMs: 5000 },
    registryDir: stateDir(t),
    ...options,
  })

const hashOfFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

// A picture to overwrite a slot's output with, for the style fixture: a real PNG, because the check reads pixels.
const png = (width: number, height: number, colour: readonly number[]): Buffer => encodePng(width, height, 6, solid(colour))

const workflowFor = (size = { width: 32, height: 16 }) => ({
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl-base.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { ...size, batch_size: 1 } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "test", images: ["8", 0] } },
})

const pngOf = (bytes: Uint8Array) => {
  const picture = readPng(bytes)
  assert.ok(!("unsupported" in picture), "the file must be a PNG this package can read")
  return picture
}

// ---------------------------------------------------------------------------------------------------------------------
// The images spec (B5-T1).

test("a version 2 image set parses with a shared checkpoint, a per-slot checkpoint and the slot's other fields", () => {
  assert.equal(SPEC_VERSIONS.images, 2)
  const spec = parsed(v2())

  assert.deepEqual(spec.model, { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA })

  // The hashes the fixtures declare are the ones the code table lists, so a changed table fails here rather than in a
  // refusal that reads like a policy decision.
  const listed = MODEL_REGISTRY.models.map((model) => model.hashes)
  assert.ok(listed.some((hashes) => hashes.includes(SDXL_SHA)), "the registry must know SDXL's published sha256")
  assert.ok(listed.some((hashes) => hashes.includes(FLUX_SHA)), "the registry must know FLUX.1 schnell's published sha256")
  assert.equal(spec.slots[0]?.seed, 7)
  assert.equal(spec.slots[0]?.negative, "text")
  assert.deepEqual(spec.slots[0]?.refs, ["refs/a.png"])
  assert.deepEqual(spec.slots[1]?.model, { name: "FLUX schnell", file: "flux1-schnell.safetensors", sha256: FLUX_SHA })
  assert.deepEqual(spec.slots[1]?.size, { width: 1024, height: 512 })
})

test("a model's keys are closed, its file is a server-relative name and its hash is a sha256", () => {
  const withModel = (model: Record<string, unknown>) => parseSpec("images", { ...v2(), model })

  assert.deepEqual(withModel({ name: "SDXL", steps: 20 }).errors, ["model.steps: unknown key"])
  assert.deepEqual(withModel({ name: "SDXL", file: "/models/sdxl.safetensors" }).errors, [
    'model.file: a checkpoint file must be relative to ComfyUI\'s models directory, got "/models/sdxl.safetensors"',
  ])
  assert.deepEqual(withModel({ name: "SDXL", file: "../other.safetensors" }).errors, [
    'model.file: a checkpoint file must not contain "." or ".." segments, got "../other.safetensors"',
  ])
  assert.deepEqual(withModel({ name: "SDXL", sha256: "ABC" }).errors, [
    'model.sha256: expected a lowercase sha256 digest of 64 hex characters, got "ABC"',
  ])
  assert.deepEqual(withModel({ name: "" }).errors, ["model.name: expected a non-empty string"])

  // A slot's model is the same record and refuses at the slot's address.
  const slot = v2()
  ;(slot["slots"] as Record<string, unknown>[])[0]!["model"] = { name: "SDXL", extra: true }
  assert.deepEqual(parseSpec("images", slot).errors, ["slots[0].model.extra: unknown key"])

  // An images.json from before B5-T1 still carries no model, and that parses: the set has simply not named one yet.
  const without = v2()
  delete without["model"]
  assert.deepEqual(parseSpec("images", without).errors, [])
})

test("a version 1 image set is refused by number, and the sentence names 2", () => {
  const stale = parseSpec("images", { ...v2(), version: 1 })
  assert.equal(stale.spec, undefined)
  assert.deepEqual(stale.errors, ["version: an images spec is version 2, got 1"])
})

// The encoder the placeholder needs. It lives in `png.ts` beside the reader, and the round trip is the whole claim: the
// checks open a placeholder with `readPng`, so a writer and a reader that agree only in this file's comments would be
// two guesses. Three by two, two colours, alpha carried through.
test("the package's own PNG writer round-trips through its reader", () => {
  const bytes = writePng({
    width: 3,
    height: 2,
    pixel: (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 255, 128]),
  })
  const picture = pngOf(bytes)
  assert.deepEqual([picture.width, picture.height], [3, 2])
  assert.deepEqual(picture.at(0, 0), [255, 0, 0, 255])
  assert.deepEqual(picture.at(1, 0), [0, 0, 255, 128])
  assert.deepEqual(picture.at(0, 1), [0, 0, 255, 128])
  assert.deepEqual(picture.at(2, 1), [0, 0, 255, 128])
})

// What replaced the two tests that used to stand here. They refused a set with no checkpoint at prepare and kept the
// placeholder B5-T5 names open as a tripwire; the acceptance is "placeholders otherwise", so a set that declares
// nothing now renders a labelled stand-in per slot. The policy around a declared checkpoint does not soften — unknown,
// unhashed, blocked and territory-refused all still refuse, as the tests above and the second half below prove.
test("a set with no model renders placeholders of the right size, passes the checks and ships with them named", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const without = v2()
  delete without["model"]
  without["slots"] = [
    { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } },
    { id: "wide", prompt: "a wide gradient", size: { width: 32, height: 16 } },
  ]
  const spec = parsed(without)
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  const prepared = await adapter.prepare(spec, ctx)
  // No checkpoint means no graph: the slot is planned as a placeholder and the run's notes say which ones, the way the
  // deck names a missing asset.
  assert.deepEqual(fake.requests, [], "a set with no checkpoint must not reach the server")
  assert.equal(existsSync(join(dir, "workflows/hero.json")), false, "no graph exists for a slot with no checkpoint")
  assert.equal(existsSync(join(dir, "workflows/wide.json")), false)
  const note = prepared.notes?.find((line) => line.startsWith("2 placeholders:"))
  assert.ok(note !== undefined, prepared.notes?.join("; "))
  assert.match(note, /2 placeholders/)
  assert.match(note, /"hero"/)
  assert.match(note, /"wide"/)

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["images/hero.placeholder.png", "images/wide.placeholder.png"])
  assert.equal(fake.prompts.length, 0, "a placeholder needs no queue entry")

  const hero = pngOf(readFileSync(join(dir, "images/hero.placeholder.png")))
  assert.deepEqual([hero.width, hero.height], [64, 48])
  const wide = pngOf(readFileSync(join(dir, "images/wide.placeholder.png")))
  assert.deepEqual([wide.width, wide.height], [32, 16])

  // A pattern, not a picture: a black border and a checkerboard of magenta and cyan, neither of which any generator in
  // this palette would make, and no text — the file name and the check carry the label.
  assert.deepEqual(hero.at(0, 0), [0, 0, 0, 255])
  assert.deepEqual(hero.at(3, 3), [255, 0, 170, 255])
  assert.deepEqual(hero.at(9, 3), [0, 229, 255, 255])

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const byId = new Map(results.map((result) => [result.id, result]))
  const placeholder = byId.get("images.placeholder")
  assert.equal(placeholder?.status, "passed", JSON.stringify(results))
  assert.match(placeholder?.output ?? "", /placeholder/)
  assert.match(placeholder?.output ?? "", /"hero"/)
  assert.match(placeholder?.output ?? "", /"wide"/)
  assert.match(placeholder?.output ?? "", /images\/hero\.placeholder\.png/)
  for (const id of ["images.count", "images.files", "images.size", "images.prompt", "images.provenance", "images.style"]) {
    assert.equal(byId.get(id)?.status, "passed", `${id}: ${JSON.stringify(byId.get(id))}`)
  }
  const coverage = evaluate(IMAGE_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(coverage.failed, [])
  assert.deepEqual(coverage.skipped.map((result) => result.id), ["images.vlm"])

  // The gate ships a set made of placeholders — they are outputs and the count is honest — and says in the report which
  // files are stand-ins, so the absence is never a silent pass.
  const report = qualityGate({ spec, defs: IMAGE_CHECKS, results, outputs: rendered.outputs })
  assert.equal(report.ship, true, JSON.stringify(report.verdicts))
  const outputs = report.verdicts.find((verdict) => verdict.id === "images.outputs")
  assert.equal(outputs?.ok, true)
  assert.match(outputs?.why ?? "", /2 outputs for 2 slots/)
  assert.match(report.warnings.join("; "), /hero\.placeholder\.png/)
  assert.match(report.warnings.join("; "), /wide\.placeholder\.png/)

  // One slot with no model and another that declares an unknown hash is still the whole set refused, not a placeholder
  // beside a graph nobody can vouch for.
  const mixed = v2()
  delete mixed["model"]
  mixed["slots"] = [
    { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } },
    {
      id: "wide",
      prompt: "a wide gradient",
      size: { width: 32, height: 16 },
      model: { name: "Unknown", file: "unknown.safetensors", sha256: "e".repeat(64) },
    },
  ]
  const refusedDir = jobDir(t)
  await assert.rejects(adapter.prepare(parsed(mixed), context(refusedDir)), /slot "wide": .*is not in the model registry/)
  assert.deepEqual(fake.requests, [], "the refused set made no request at all")
  assert.equal(existsSync(join(refusedDir, "images")), false, "no placeholder stood in for the refused slot")

  // And a checkpoint that is named but has no hash to resolve is the same refusal, not a placeholder with a better name:
  // a name proves nothing, because a workflow can load any checkpoint on disk.
  const bare = v2()
  bare["model"] = { name: "SDXL base", file: "sdxl-base.safetensors" }
  bare["slots"] = [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }]
  const bareDir = jobDir(t)
  await assert.rejects(adapter.prepare(parsed(bare), context(bareDir)), (error: Error) => {
    assert.match(error.message, /^images: slot "hero": /)
    assert.match(error.message, /has no sha256 to resolve/)
    return true
  })
  assert.equal(existsSync(join(bareDir, "images")), false)
})

test("a placeholder file that is truncated after the render fails the check, naming the slot", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const without = v2()
  delete without["model"]
  without["slots"] = [
    { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } },
    { id: "wide", prompt: "a wide gradient", size: { width: 32, height: 16 } },
  ]
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)
  await adapter.prepare(parsed(without), ctx)
  await adapter.render(ctx)

  const path = join(dir, "images/hero.placeholder.png")
  writeFileSync(path, readFileSync(path).subarray(0, 30))

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const placeholder = results.find((result) => result.id === "images.placeholder")
  assert.equal(placeholder?.status, "failed", JSON.stringify(results))
  assert.match(placeholder?.reason ?? "", /placeholder/)
  assert.match(placeholder?.reason ?? "", /"hero"/)
  assert.match(placeholder?.reason ?? "", /images\/hero\.placeholder\.png/)
  // The slot that is still readable is not blamed, and the file check says the same thing about the bytes: a stand-in
  // nobody can open is an absence with extra steps.
  assert.doesNotMatch(placeholder?.reason ?? "", /"wide"/)
  assert.equal(results.find((result) => result.id === "images.files")?.status, "failed")
  assert.equal(results.find((result) => result.id === "images.count")?.status, "passed")
})

// ---------------------------------------------------------------------------------------------------------------------
// The client (B5-T2).

test("object_info, upload, prompt and history answer with values, and history says when a job is still pending", async (t) => {
  const fake = await fakeFor(t)
  fake.pendingPolls = 1
  const client = clientFor(fake)

  const info = await client.objectInfo()
  assert.equal(info.ok, true)
  if (info.ok) assert.ok("CheckpointLoaderSimple" in info.value)

  const upload = await client.uploadImage({ name: "ref.png", bytes: new Uint8Array([1, 2, 3, 4]) })
  assert.equal(upload.ok, true)
  assert.deepEqual(upload.ok ? upload.value : undefined, { filename: "ref.png", subfolder: "", type: "input" })
  assert.deepEqual(fake.uploaded, ["ref.png"])

  const prompt = await client.prompt(workflowFor())
  assert.equal(prompt.ok, true)
  if (!prompt.ok) return
  const id = prompt.value.id
  assert.equal(fake.prompts.length, 1)

  const first = await client.history(id)
  assert.equal(first.ok, true)
  if (first.ok) {
    assert.equal(first.value.pending, true)
    assert.deepEqual(first.value.images, [])
  }

  const second = await client.history(id)
  assert.equal(second.ok, true)
  if (second.ok) {
    assert.equal(second.value.pending, false)
    assert.equal(second.value.failed, false)
    assert.deepEqual(second.value.images, [{ filename: `${id}.png`, subfolder: "", type: "output" }])
  }
})

test("view returns the produced bytes, and the size is the workflow's empty latent", async (t) => {
  const fake = await fakeFor(t)
  const client = clientFor(fake)

  const prompt = await client.prompt(workflowFor({ width: 40, height: 24 }))
  if (!prompt.ok) throw new Error(prompt.refused)
  const history = await client.history(prompt.value.id)
  if (!history.ok || history.value.images.length === 0) throw new Error("the fake must produce a picture")

  const view = await client.view(history.value.images[0]!)
  assert.equal(view.ok, true)
  if (!view.ok) return
  const picture = pngOf(view.value)
  assert.equal(picture.width, 40)
  assert.equal(picture.height, 24)
})

test("a timeout, a 500 and a closed port are refusals, not throws", async (t) => {
  const slow = await fakeFor(t)
  slow.slowMs = 200
  const timed = new ComfyClient({ url: slow.url, timeoutMs: 30 })
  const timeout = await timed.objectInfo()
  assert.equal(timeout.ok, false)
  if (!timeout.ok) assert.match(timeout.refused, /could not reach/)

  const broken = await fakeFor(t, { objectInfoStatus: 500 })
  const serverError = await clientFor(broken).objectInfo()
  assert.equal(serverError.ok, false)
  if (!serverError.ok) {
    assert.equal(serverError.status, 500)
    assert.match(serverError.refused, /HTTP 500/)
  }

  const closed = await new FakeComfy().listen()
  const gone = closed.url
  await closed.close()
  const refused = await new ComfyClient({ url: gone, timeoutMs: 500 }).objectInfo()
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.refused, /could not reach/)
})

test("a checkpoint the server refuses is a refusal value, with the server's node errors in it", async (t) => {
  const fake = await fakeFor(t)
  fake.blockedCheckpoint = "banned.safetensors"
  const client = clientFor(fake)

  const answer = await client.prompt({
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "banned.safetensors" } },
  })
  assert.equal(answer.ok, false)
  if (!answer.ok) {
    assert.equal(answer.status, 400)
    assert.match(answer.refused, /HTTP 400/)
    assert.match(answer.refused, /blocked checkpoint/)
  }
})

test("a remote host is refused unless it is declared with allowRemote", async () => {
  const remote = new ComfyClient({ url: "http://192.0.2.10:8188" })
  assert.match(remote.refusal ?? "", /192\.0\.2\.10:8188 is not loopback/)
  assert.match(remote.refusal ?? "", /allowRemote: true/)
  const answer = await remote.objectInfo()
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.match(answer.refused, /allowRemote: true/)

  // The declaration is code: the same URL with the option is accepted without a request being made here.
  const declared = new ComfyClient({ url: "http://192.0.2.10:8188", allowRemote: true })
  assert.equal(declared.refusal, undefined)

  const bad = new ComfyClient({ url: "file:///tmp/comfy" })
  assert.match(bad.refusal ?? "", /must be http or https/)
})

test("watch normalises /ws progress to id, node, value and max, and finishes on history", async (t) => {
  const fake = await fakeFor(t)
  fake.deferUntilWs = true
  fake.pendingPolls = 1000
  const client = clientFor(fake, { pollMs: 10, watchTimeoutMs: 3000 })
  assert.equal(client.watchTransport, "ws")

  const prompt = await client.prompt(workflowFor())
  if (!prompt.ok) throw new Error(prompt.refused)
  const progress: ComfyProgress[] = []
  const watched = await client.watch(prompt.value.id, (entry) => progress.push(entry))

  assert.equal(watched.ok, true)
  if (watched.ok) {
    assert.equal(watched.value.pending, false)
    assert.equal(watched.value.images.length, 1)
  }
  assert.deepEqual(progress, [
    { id: prompt.value.id, node: "3", value: 1, max: 3 },
    { id: prompt.value.id, node: "3", value: 2, max: 3 },
    { id: prompt.value.id, node: "3", value: 3, max: 3 },
  ])
})

test("without a WebSocket client watch polls /history and says so", async (t) => {
  const fake = await fakeFor(t)
  fake.pendingPolls = 2
  const client = clientFor(fake, { pollMs: 5, watchTimeoutMs: 3000, webSocket: false })
  assert.equal(client.watchTransport, "poll")

  const prompt = await client.prompt(workflowFor())
  if (!prompt.ok) throw new Error(prompt.refused)
  const progress: ComfyProgress[] = []
  const watched = await client.watch(prompt.value.id, (entry) => progress.push(entry))

  assert.deepEqual(progress, [])
  assert.equal(watched.ok, true)
  if (watched.ok) {
    assert.equal(watched.value.pending, false)
    assert.equal(watched.value.images.length, 1)
  }
})

test("a watch that never finishes is a refusal with the timeout in it", async (t) => {
  const fake = await fakeFor(t)
  fake.pendingPolls = 1_000_000
  const client = clientFor(fake, { pollMs: 5, watchTimeoutMs: 40, webSocket: false })
  const prompt = await client.prompt(workflowFor())
  if (!prompt.ok) throw new Error(prompt.refused)
  const watched = await client.watch(prompt.value.id, () => {})
  assert.equal(watched.ok, false)
  if (!watched.ok) assert.match(watched.refused, /did not finish within 40 ms/)
})

// ---------------------------------------------------------------------------------------------------------------------
// The adapter.

test("two slots render two pictures sequentially, at their own sizes, and every mechanical check passes", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const spec = parsed({
    ...v2(),
    slots: [
      { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 }, seed: 7, negative: "text" },
      { id: "wide", prompt: "a wide gradient", size: { width: 32, height: 16 } },
    ],
  })
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  const prepared = await adapter.prepare(spec, ctx)
  assert.ok(prepared.notes?.some((note) => /2 slots across 1 checkpoint/.test(note)))

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["images/hero.png", "images/wide.png"])
  assert.equal(fake.prompts.length, 2, "one prompt per slot, not one batch")

  const hero = pngOf(readFileSync(join(dir, "images/hero.png")))
  assert.deepEqual([hero.width, hero.height], [64, 48])
  const wide = pngOf(readFileSync(join(dir, "images/wide.png")))
  assert.deepEqual([wide.width, wide.height], [32, 16])

  assert.ok(existsSync(join(dir, "workflows/hero.json")))
  assert.ok(existsSync(join(dir, "workflows/wide.json")))

  const shots = await adapter.snapshot(ctx)
  assert.deepEqual(shots.shots.map((shot) => shot.label), ["hero", "wide"])

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  assert.deepEqual(
    results.map((result) => [result.id, result.status]),
    [
      ["images.count", "passed"],
      ["images.files", "passed"],
      ["images.size", "passed"],
      ["images.prompt", "passed"],
      ["images.provenance", "passed"],
      ["images.placeholder", "passed"],
      ["images.style", "passed"],
      ["images.vlm", "skipped"],
    ],
    JSON.stringify(results),
  )
  assert.deepEqual(evaluate(IMAGE_CHECKS, results).invalid, [])
})

test("a different checkpoint on one slot gets its own workflow, while the other slot inherits the set's", async (t) => {
  const dir = jobDir(t)
  mkdirSync(join(dir, "refs"))
  writeFileSync(join(dir, "refs/a.png"), "a ref the job carries")
  const project: ImageProject = await writeImageProject(parsed(v2()), dir)

  assert.deepEqual(
    project.slots.map((slot) => slot.model?.name),
    ["SDXL base", "FLUX schnell"],
  )
  assert.notEqual(project.slots[0]?.workflow, project.slots[1]?.workflow)

  const first = JSON.parse(readFileSync(join(dir, project.slots[0]!.workflow!), "utf8")) as Record<
    string,
    { inputs: Record<string, unknown> }
  >
  const second = JSON.parse(readFileSync(join(dir, project.slots[1]!.workflow!), "utf8")) as Record<
    string,
    { inputs: Record<string, unknown> }
  >
  assert.equal(first["4"]?.inputs["ckpt_name"], "sdxl-base.safetensors")
  assert.equal(second["4"]?.inputs["ckpt_name"], "flux1-schnell.safetensors")
  assert.equal(first["5"]?.inputs["width"], 512)
  assert.equal(second["5"]?.inputs["width"], 1024)
  assert.equal(first["3"]?.inputs["seed"], 7)
  // A slot with no seed gets one derived from the job and its id, so two runs of the same spec are the same run.
  assert.equal(typeof second["3"]?.inputs["seed"], "number")
})

test("the workflow template is the code-owned text-to-image graph", () => {
  const graph = imageWorkflow({
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
    prompt: "a calm gradient",
    negative: "text",
    size: { width: 64, height: 32 },
    seed: 11,
    prefix: "omacode/job-1/hero",
  }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>

  assert.deepEqual(
    Object.values(graph)
      .map((node) => node.class_type)
      .sort(),
    ["CheckpointLoaderSimple", "CLIPTextEncode", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "SaveImage", "VAEDecode"].sort(),
  )
  assert.equal(graph["4"]?.inputs["ckpt_name"], "sdxl-base.safetensors")
  assert.equal(graph["6"]?.inputs["text"], "a calm gradient")
  assert.equal(graph["7"]?.inputs["text"], "text")
  assert.equal(graph["5"]?.inputs["width"], 64)
  assert.equal(graph["5"]?.inputs["height"], 32)
  assert.equal(graph["3"]?.inputs["seed"], 11)
  assert.equal(graph["9"]?.inputs["filename_prefix"], "omacode/job-1/hero")
  // The graph is JSON, not a command: serialising it is the client's whole use of it.
  assert.doesNotThrow(() => JSON.stringify(graph))
})

test("a failing job is reflected in the checks with the server's reason, not swallowed", async (t) => {
  const fake = await fakeFor(t)
  fake.failJobs = 1
  const dir = jobDir(t)
  const spec = parsed({
    ...v2(),
    slots: [
      { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } },
      { id: "wide", prompt: "a wide gradient", size: { width: 32, height: 16 } },
    ],
  })
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  await adapter.prepare(spec, ctx)
  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["images/wide.png"])
  assert.ok(ctx.logs.some((line) => /slot "hero".*out of memory/.test(line)))

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const byId = new Map(results.map((result) => [result.id, result]))
  assert.equal(byId.get("images.count")?.status, "failed")
  assert.match(byId.get("images.count")?.reason ?? "", /1 file for 2 slots/)
  assert.equal(byId.get("images.files")?.status, "failed")
  assert.match(byId.get("images.files")?.reason ?? "", /hero/)
  assert.match(byId.get("images.files")?.reason ?? "", /out of memory/)
  assert.deepEqual(evaluate(IMAGE_CHECKS, results).invalid, [])
})

test("a broken picture is refused by the render, and the check says why the slot has no file", async (t) => {
  const fake = await fakeFor(t)
  fake.brokenImage = true
  const dir = jobDir(t)
  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  await adapter.prepare(spec, ctx)
  await assert.rejects(adapter.render(ctx), /no slot produced a picture.*not a PNG/s)

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const files = results.find((result) => result.id === "images.files")
  assert.equal(files?.status, "failed")
  assert.match(files?.reason ?? "", /not a PNG/)
  assert.equal(results.find((result) => result.id === "images.count")?.status, "failed")
})

test("a ref outside the job is refused before the server is asked anything", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const outside = mkdtempSync(join(tmpdir(), "mm-image-outside-"))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const secret = join(outside, "outside.png")
  writeFileSync(secret, "not really a picture")
  mkdirSync(join(dir, "refs"))
  symlinkSync(secret, join(dir, "refs/link.png"))

  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 }, refs: ["refs/link.png"] }],
  })
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  await assert.rejects(adapter.prepare(spec, ctx), /ref "refs\/link\.png" resolves outside the job directory/)
  assert.deepEqual(fake.requests, [])
  assert.equal(existsSync(join(dir, "workflows")), false)
})

test("the adapter is complete, declares the socket as its one capability, and has no editor or present step", () => {
  const adapter = imageAdapter()
  assert.doesNotThrow(() => assertAdapter(adapter))
  assert.equal(adapter.kind, "images")
  assert.equal(adapter.name, "comfyui")
  assert.deepEqual([...executablesOf(adapter)], [])
  assert.equal(networkOf(adapter), true)
  assert.equal(adapter.openEditor, undefined)
  assert.equal("present" in adapter, false)
})

test("an L0 contract definition handed to the adapter is skipped with its reason, never a green line", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)
  await adapter.prepare(spec, ctx)
  await adapter.render(ctx)

  const contractDef = {
    id: "images.contract",
    level: "L0" as const,
    kind: "images" as const,
    title: "the spec parses",
    run: "spec" as const,
    required: true,
  }
  const results: readonly CheckResult[] = await adapter.check(ctx, [contractDef])
  assert.deepEqual(results, [
    {
      id: "images.contract",
      level: "L0",
      status: "skipped",
      code: -1,
      reason: 'images.contract is produced by the spec parse (L0, run: "spec"), not by the image adapter',
    },
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
// The checkpoint policy in the adapter (B5-T4).

test("a checkpoint whose hash nobody recorded is refused before any request and leaves no workflow behind", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const unknown = "f".repeat(64)
  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: unknown },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  await assert.rejects(adapter.prepare(spec, ctx), (error: Error) => {
    assert.match(error.message, /^images: slot "hero": /)
    assert.match(error.message, new RegExp(unknown))
    assert.match(error.message, /is not in the model registry, so it is refused/)
    assert.match(error.message, /a name proves nothing, because a workflow can load any checkpoint on disk/)
    assert.match(error.message, /registerModel\(\{ hash, name, license, territory \}\)/)
    return true
  })
  assert.deepEqual(fake.requests, [], "an unknown checkpoint must not reach the server")
  assert.equal(existsSync(join(dir, "workflows")), false, "a refused job writes no graph")
})

test("a blocklisted hash is refused by name and reason before the server is asked", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const hash = digest("a checkpoint whose licence excludes the EU")
  const registry: ModelRegistry = {
    models: [],
    blocked: [{ name: "An excluded model", reason: "its licence excludes the EU (D3)", hashes: [hash] }],
  }
  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: hash },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const adapter = adapterFor(t, fake, { registry })
  const ctx = context(dir)

  await assert.rejects(adapter.prepare(spec, ctx), (error: Error) => {
    assert.match(error.message, /is blocked as "An excluded model"/)
    assert.match(error.message, /its licence excludes the EU \(D3\)/)
    return true
  })
  assert.deepEqual(fake.requests, [])
  assert.equal(existsSync(join(dir, "workflows")), false)
})

test("a licence that permits no EU use is refused by the adapter, and allowed for the territory it names", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  // A hash this table knows, in a registry that records it as US-only. The blocklist is empty on purpose: the refusal
  // being tested is the territory, not a block.
  const hash = digest("weights whose licence is US-only")
  const registry: ModelRegistry = {
    models: [{ name: "US only", spdx: "Apache-2.0", territories: ["US"], use: "tests", hashes: [hash], verified: "listed in this test" }],
    blocked: [],
  }
  const spec = parsed({
    ...v2(),
    model: { name: "US only", file: "us-only.safetensors", sha256: hash },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 32, height: 16 } }],
  })

  // The default territory is the EU, and the adapter refuses with the licence and the territories that would work.
  await assert.rejects(adapterFor(t, fake, { registry }).prepare(spec, context(dir)), (error: Error) => {
    assert.match(error.message, /may not be used in EU/)
    assert.match(error.message, /Apache-2\.0/)
    assert.match(error.message, /permits US/)
    return true
  })
  assert.deepEqual(fake.requests, [])
  assert.equal(existsSync(join(dir, "workflows")), false)

  // The same hash resolved for the territory the licence names proceeds: the refusal was about the territory, not the
  // weights, and the caller states the territory in code rather than the spec.
  const us = adapterFor(t, fake, { registry, territory: "US" })
  const usCtx = context(dir)
  const prepared = await us.prepare(spec, usCtx)
  assert.ok(prepared.notes?.some((note) => /resolved by sha256 for use in US/.test(note)), prepared.notes?.join("; "))
  const rendered = await us.render(usCtx)
  assert.deepEqual(rendered.outputs, ["images/hero.png"])
})

test("the file in the job decides the hash, not the name the spec declared", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const state = stateDir(t)
  // A file whose name claims SDXL and whose bytes are a few words. The name is refused, and the sentence quotes the hash
  // the file really has, which is what a registry would have to know.
  writeFileSync(join(dir, "checkpoint.safetensors"), "weights that are not SDXL")
  const real = hashOfFile(join(dir, "checkpoint.safetensors"))

  const spec = (model: Record<string, unknown>) =>
    parsed({
      ...v2(),
      model,
      slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
    })

  const adapter = adapterFor(t, fake, { registryDir: state })
  await assert.rejects(
    adapter.prepare(spec({ name: "SDXL base", file: "checkpoint.safetensors" }), context(dir)),
    (error: Error) => {
      assert.match(error.message, new RegExp(real))
      assert.match(error.message, /is not in the model registry/)
      return true
    },
  )
  assert.deepEqual(fake.requests, [])

  // A declared hash that disagrees with the bytes is its own refusal: whichever of the two is wrong would travel.
  await assert.rejects(
    adapter.prepare(spec({ name: "SDXL base", file: "checkpoint.safetensors", sha256: SDXL_SHA }), context(dir)),
    (error: Error) => {
      assert.match(error.message, /hashes to /)
      assert.match(error.message, /not the declared /)
      return true
    },
  )
  assert.deepEqual(fake.requests, [])

  // Registering the hash the file really has makes it allowed, and the decision records that the hash was read here.
  registerModel({ hash: real, name: "A checkpoint I installed", license: "Apache-2.0", territory: "EU" }, { dir: state })
  const registered = readModelRegistry({ dir: state })
  const project = await writeImageProject(spec({ name: "SDXL base", file: "checkpoint.safetensors" }), dir, {
    registry: registryWith(registered.entries),
  })
  assert.equal(project.slots[0]?.checkpoint?.verified, true)
  assert.equal(project.slots[0]?.checkpoint?.hash, real)
})

test("an unknown hash that was registered proceeds, end to end, and one that was not stays refused", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const state = stateDir(t)
  const hash = digest("the weights I registered")
  const spec = parsed({
    ...v2(),
    model: { name: "My checkpoint", file: "not-installed.safetensors", sha256: hash },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })

  await assert.rejects(adapterFor(t, fake, { registryDir: state }).prepare(spec, context(dir)), /is not in the model registry/)
  assert.deepEqual(fake.requests, [])

  registerModel({ hash, name: "My checkpoint", license: "Apache-2.0", territory: "EU" }, { dir: state })

  const adapter = adapterFor(t, fake, { registryDir: state })
  const ctx = context(dir)
  const prepared = await adapter.prepare(spec, ctx)
  assert.ok(prepared.notes?.some((note) => /resolved by sha256 for use in EU/.test(note)))
  assert.ok(prepared.notes?.some((note) => /1 hash came from the spec because the file is not here/.test(note)))

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["images/hero.png"])
  assert.equal(fake.prompts.length, 1)

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const provenance = results.find((result) => result.id === "images.provenance")
  assert.equal(provenance?.status, "passed", JSON.stringify(results))
})

test("a registry file that lost a licence is a refusal, not an empty registry", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const state = stateDir(t)
  mkdirSync(state, { recursive: true })
  writeFileSync(
    join(state, "models.json"),
    JSON.stringify({
      version: 1,
      models: [{ name: "Half an entry", territories: ["EU"], use: "tests", hashes: ["c".repeat(64)] }],
    }),
  )

  const adapter = adapterFor(t, fake, { registryDir: state })
  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  await assert.rejects(adapter.prepare(spec, context(dir)), (error: Error) => {
    assert.match(error.message, /the model registry cannot be read, so no checkpoint is allowed/)
    assert.match(error.message, /models\[0\]\.spdx: expected a non-empty licence identifier/)
    return true
  })
  assert.deepEqual(fake.requests, [])
})

test("a checkpoint under a declared model directory is hashed from that file", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const state = stateDir(t)
  const models = mkdtempSync(join(tmpdir(), "mm-image-models-"))
  t.after(() => rmSync(models, { recursive: true, force: true }))
  writeFileSync(join(models, "checkpoint.safetensors"), "weights an installed ComfyUI keeps")
  const real = hashOfFile(join(models, "checkpoint.safetensors"))
  registerModel({ hash: real, name: "A checkpoint under the models directory", license: "Apache-2.0", territory: "EU" }, { dir: state })

  const adapter = adapterFor(t, fake, { registryDir: state, modelDirs: [models] })
  const spec = parsed({
    ...v2(),
    model: { name: "SDXL base", file: "checkpoint.safetensors" },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const project = await writeImageProject(spec, dir, {
    registry: registryWith(readModelRegistry({ dir: state }).entries),
    modelDirs: [models],
  })

  const checkpoint = project.slots[0]?.checkpoint
  assert.equal(checkpoint?.hash, real, "the file, not the name, decided")
  assert.equal(checkpoint?.verified, true)
  assert.equal(checkpoint?.file, join(models, "checkpoint.safetensors"))
  assert.equal(checkpoint?.spdx, "Apache-2.0")

  // The adapter itself takes the same route.
  const ctx = context(dir)
  await adapter.prepare(spec, ctx)
  assert.ok(ctx.logs.some((line) => /all were hashed from a file on this machine/.test(line)))
})

test("one unknown slot refuses the set before the slot that was allowed has a workflow", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const spec = parsed({
    ...v2(),
    slots: [
      { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } },
      {
        id: "wide",
        prompt: "a wide gradient",
        size: { width: 32, height: 16 },
        model: { name: "Unknown", file: "unknown.safetensors", sha256: "e".repeat(64) },
      },
    ],
  })
  const adapter = adapterFor(t, fake)
  await assert.rejects(adapter.prepare(spec, context(dir)), /slot "wide": .*is not in the model registry/)
  assert.deepEqual(fake.requests, [])
  assert.equal(existsSync(join(dir, "workflows")), false, "hero resolved, but no workflow was written for it")
})

// ---------------------------------------------------------------------------------------------------------------------
// The checks (B5-T5).

const twoSlots = (): ImagesSpec =>
  parsed({
    ...v2(),
    slots: [
      { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 }, seed: 7 },
      { id: "wide", prompt: "a wide gradient", size: { width: 32, height: 16 } },
    ],
  })

test("the vision review is skipped with the D13/D21 reason while the deterministic checks pass and the gate ships", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  await adapter.prepare(twoSlots(), ctx)
  const rendered = await adapter.render(ctx)
  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const byId = new Map(results.map((result) => [result.id, result]))

  const vlm = byId.get("images.vlm")
  assert.equal(vlm?.status, "skipped")
  assert.equal(vlm?.code, -1)
  assert.match(vlm?.reason ?? "", /no local vision model is configured/)
  assert.match(vlm?.reason ?? "", /D13\/D21/)

  // The prompt's own words reached the graph, the set is one colour, and every slot carries its checkpoint's facts.
  assert.equal(byId.get("images.prompt")?.status, "passed")
  assert.match(byId.get("images.prompt")?.output ?? "", /prompt words .* reach their workflows/)
  assert.equal(byId.get("images.style")?.status, "passed")
  assert.equal(byId.get("images.provenance")?.status, "passed")
  assert.match(byId.get("images.provenance")?.output ?? "", /named with a hash, a licence and a territory/)

  const coverage = evaluate(IMAGE_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(coverage.failed, [])
  assert.deepEqual(coverage.skipped.map((result) => result.id), ["images.vlm"])

  // And a skipped `images.vlm` is declared skippable, so the gate ships with the absence as a warning: the review did
  // not happen, and the report says so instead of showing a green line where a look should be.
  const report = qualityGate({ spec: twoSlots(), defs: IMAGE_CHECKS, results, outputs: rendered.outputs })
  assert.equal(report.ship, true, JSON.stringify(report.verdicts))
  assert.ok(report.warnings.some((warning) => /images\.vlm was skipped/.test(warning)), JSON.stringify(report.warnings))
})

test("the deterministic checks fail on a tampered prompt, a rewritten workflow and an off-palette picture", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)

  await adapter.prepare(twoSlots(), ctx)
  await adapter.render(ctx)

  // `hero`'s graph lost its prompt: the words are still in the spec and are no longer in what the server was asked.
  const heroPath = join(dir, "workflows/hero.json")
  const hero = JSON.parse(readFileSync(heroPath, "utf8")) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  for (const node of Object.values(hero)) {
    if (node.class_type === "CLIPTextEncode") node.inputs["text"] = "nothing at all"
  }
  writeFileSync(heroPath, JSON.stringify(hero))

  // `wide`'s graph names a checkpoint nobody resolved, and its picture is a red frame in a blue set.
  const widePath = join(dir, "workflows/wide.json")
  const wide = JSON.parse(readFileSync(widePath, "utf8")) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  for (const node of Object.values(wide)) {
    if (node.class_type === "CheckpointLoaderSimple") node.inputs["ckpt_name"] = "somebody-elses.safetensors"
  }
  writeFileSync(widePath, JSON.stringify(wide))
  writeFileSync(join(dir, "images/wide.png"), png(32, 16, [220, 30, 30, 255]))

  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const byId = new Map(results.map((result) => [result.id, result]))

  const prompt = byId.get("images.prompt")
  assert.equal(prompt?.status, "failed", JSON.stringify(results))
  assert.match(prompt?.reason ?? "", /hero asked for .*calm/)
  assert.match(prompt?.reason ?? "", /gradient/)

  const provenance = byId.get("images.provenance")
  assert.equal(provenance?.status, "failed")
  assert.match(provenance?.reason ?? "", /wide's workflow loads "somebody-elses\.safetensors"/)

  const style = byId.get("images.style")
  assert.equal(style?.status, "failed")
  assert.match(style?.reason ?? "", /wide does not fit the set/)
  assert.match(style?.reason ?? "", /colours overlap the rest of the set/)

  assert.deepEqual(evaluate(IMAGE_CHECKS, results).invalid, [])
})

// ---------------------------------------------------------------------------------------------------------------------
// GPU contention (B5-T6).

test("one render at a time: a second render is refused with the runner's sentence, and the fake never saw two prompts", async (t) => {
  const fake = await fakeFor(t)
  fake.slowMs = 30
  const dir = jobDir(t)
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)
  await adapter.prepare(twoSlots(), ctx)

  // `render` takes the slot synchronously, so the second call meets it before the first has awaited anything.
  const first = adapter.render(ctx)
  await assert.rejects(adapter.render(ctx), /^Error: images: another run is active$/)

  const rendered = await first
  assert.equal(rendered.outputs.length, 2)
  assert.equal(fake.peakPrompts, 1, "two graphs were sent at once")

  // The slot is free again: a later render is a new run, not a second one.
  fake.slowMs = 0
  const again = await adapter.render(ctx)
  assert.equal(again.outputs.length, 2)
})

test("the host runner's own rule is the same sentence: one program at a time", async (t) => {
  const dir = jobDir(t)
  const pid = join(dir, "pid")
  const runner = await createHostRunner({ allow: ["node"], jobDir: dir, network: true })

  const first = runner.run({
    exe: "node",
    args: ["-e", 'require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 10000)'],
  })
  for (let tries = 0; tries < 200 && !existsSync(pid); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(existsSync(pid), "the first run must have started")

  const second = await runner.run({ exe: "node", args: ["-e", "process.exit(0)"] })
  assert.equal(second.refused, "another run is active")
  assert.equal(second.passed, false)
  assert.equal(second.code, -1)

  runner.cancel()
  assert.equal((await first).cancelled, true)
})

// ---------------------------------------------------------------------------------------------------------------------
// The cloud shape (B5-T3).

test("the cloud image backend is absent without a key, and refuses with its reasons when one is configured", async () => {
  const absent = cloudImageBackend({})
  assert.equal(absent.backend, undefined)
  assert.match(absent.refusal ?? "", new RegExp(`no cloud image backend without an API key \\(${CLOUD_IMAGE_KEY_ENV}\\)`))

  // With a key the shape exists, and every call refuses: the artifact package may not import the plugin's egress gate
  // (micromanager depends on artifact), and a second gate here would be a second answer.
  const configured = cloudImageBackend({ apiKey: "sk-not-a-real-key", budgetUsd: 5 })
  assert.ok(configured.backend)
  if (configured.backend === undefined) return
  assert.equal(configured.backend.available, false)
  assert.equal(configured.backend.budgetUsd, 5)
  assert.match(configured.backend.refusal, /egress gate D13 requires/)
  assert.match(configured.backend.refusal, /packages\/micromanager\/src\/egress\.ts/)
  assert.match(configured.backend.refusal, /artifact daemon's ledger \(B6\)/)
  assert.match(configured.backend.refusal, /terms are not recorded/)

  // Terms the caller has read are kept and are no longer listed as missing.
  const withTerms = cloudImageBackend({ apiKey: "sk-not-a-real-key", terms: "no training on prompts" })
  assert.equal(withTerms.backend?.terms, "no training on prompts")
  assert.doesNotMatch(withTerms.backend?.refusal ?? "", /terms are not recorded/)

  const answer = await configured.backend.generate({ prompt: "a calm gradient", size: { width: 64, height: 48 } })
  assert.equal(answer.ok, false)
  if (!answer.ok) assert.match(answer.refused, /no cloud image call is made/)

  // The key is read and never repeated, in a refusal or in the object a caller could log.
  assert.equal(JSON.stringify(configured).includes("sk-not-a-real-key"), false)

  // The adapter has no cloud option at all: there is no configuration in this round under which a picture comes from a
  // host, which is what "absent with a refusal reason" means rather than a backend that half works.
  assert.equal("cloud" in imageAdapter(), false)
})

// ---------------------------------------------------------------------------------------------------------------------
// The job's acceptance (B5-T7). §5 B5 asks for "images work when a model exists, placeholders otherwise, and an unknown
// or EU-excluded checkpoint is refused rather than silently used". The first test below is the whole chain for the
// model-that-exists half: a plan.md rendered by the plugin's own renderer, one promoted picture, the handoff's images
// spec, the adapter against the fake server, the manifest, the checks and the gate. The second is the same chain with
// one unknown hash, where the refusal has to leave the server's request log empty.

// What a plan leaves behind for an image set: the promoted PNG at the path plan.md records, and the document that
// describes it. The picture is a real PNG, because plan.md's artifact table hashes bytes and an image slot's prompt
// comes from the file's name.
const imagePlanFixture = async (
  t: TestContext,
  options: { readonly width?: number; readonly height?: number; readonly colour?: readonly number[] } = {},
): Promise<{ root: string; planMd: string; asset: string; sha256: string; bytes: number; brief: string }> => {
  const project = mkdtempSync(join(tmpdir(), "mm-image-plan-"))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const root = artifactsRootFor(project, "job-1")
  const asset = "t1/hero.png"
  const bytes = png(options.width ?? 64, options.height ?? 48, options.colour ?? [90, 120, 200, 255])
  const promoted = join(root, ...asset.split("/"))
  mkdirSync(dirname(promoted), { recursive: true })
  writeFileSync(promoted, bytes)
  const sha256 = await sha256File(promoted)

  const brief = "images for the release"
  const plan: PlanDoc = {
    goal: brief,
    findings: [],
    decisions: [],
    openQuestions: [],
    tasks: [{ id: "t1", title: "Mock it up", role: "worker", files: [], acceptance: [] }],
    artifacts: [{ task: "t1", path: "hero.png", bytes: bytes.length, sha256 }],
    risks: [],
  }
  return { root, planMd: renderPlanDoc({ id: "job-1" }, plan), asset, sha256, bytes: bytes.length, brief }
}

test("the manifest records every rendered picture, and a rewritten picture is detected as changed", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const adapter = adapterFor(t, fake)
  const ctx = context(dir)
  await adapter.prepare(twoSlots(), ctx)
  const rendered = await adapter.render(ctx)

  const manifest = await manifestOf(
    dir,
    rendered.outputs.map((path) => ({ path, source: "model" as const })),
  )
  assert.deepEqual(manifest.assets.map((entry) => entry.path), ["images/hero.png", "images/wide.png"])
  for (const entry of manifest.assets) {
    assert.equal(entry.source, "model")
    assert.ok(entry.bytes > 0, `${entry.path} has bytes`)
    assert.equal(entry.sha256, await sha256File(join(dir, entry.path)), `${entry.path}'s hash is its file's`)
  }
  assert.deepEqual(await verifyManifest(dir, manifest), { ok: true, missing: [], changed: [], outside: [] })

  // Same path, different bytes, still a valid PNG: only the manifest's hash can tell that the set changed. This is the
  // case a size or a picture check would call fine, which is why the manifest exists.
  writeFileSync(join(dir, "images/wide.png"), png(32, 16, [10, 200, 10, 255]))
  assert.deepEqual(await verifyManifest(dir, manifest), {
    ok: false,
    missing: [],
    changed: ["images/wide.png"],
    outside: [],
  })
})

test("a plan's promoted picture becomes an image set that renders, manifests, checks out and ships", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const fixture = await imagePlanFixture(t)

  const handoff = await specFromPlan({
    planMd: fixture.planMd,
    artifactsRoot: fixture.root,
    kind: "images",
    job: "job-1",
    brief: fixture.brief,
  })
  assert.deepEqual(handoff.errors, [])
  const briefed = handoff.spec
  assert.ok(briefed !== undefined && briefed.kind === "images", "the handoff must produce an image spec")
  if (!briefed || briefed.kind !== "images") return

  // plan.md's artifact table is all the handoff has: one file becomes one slot, its stem the prompt, the default size
  // stated as a warning. The version is B5-T1's 2, and the promoted file is recorded at the plan's hash.
  assert.equal(briefed.version, 2)
  assert.deepEqual(
    briefed.slots.map((slot) => [slot.id, slot.prompt, slot.size]),
    [["t1-hero-png", "hero", { width: 1024, height: 1024 }]],
  )
  assert.deepEqual(handoff.used, [{ task: "t1", path: fixture.asset, sha256: fixture.sha256 }])
  assert.equal(briefed.model, undefined, "plan.md carries no checkpoint column, so the handoff cannot name one")
  assert.ok(
    handoff.warnings.some((line) => line.includes(fixture.asset) && line.includes("the file's name")),
    handoff.warnings.join("; "),
  )

  // The checkpoint is the build job's decision, not the plan's: plan.md has no column for it, so the caller declares
  // one on the spec and parses it again. Without that declaration the set renders placeholders (the test above): a
  // labelled set with a reason rather than a default checkpoint nobody chose.
  const withModel = parseSpec("images", {
    ...briefed,
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: SDXL_SHA },
  })
  assert.deepEqual(withModel.errors, [])
  const spec = withModel.spec
  assert.ok(spec !== undefined && spec.kind === "images")
  if (!spec || spec.kind !== "images") return

  // Stage the promoted file into the job under the path the spec names: the plan's bytes, not a copy that claims them.
  const staged = join(dir, ...fixture.asset.split("/"))
  mkdirSync(dirname(staged), { recursive: true })
  copyFileSync(join(fixture.root, ...fixture.asset.split("/")), staged)
  assert.equal(await sha256File(staged), spec.assets?.[0]?.sha256, "the staged bytes are the plan's bytes")

  const adapter = adapterFor(t, fake)
  const ctx = context(dir)
  const prepared = await adapter.prepare(spec, ctx)
  assert.ok(prepared.notes?.some((note) => /resolved by sha256 for use in EU/.test(note)), prepared.notes?.join("; "))

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["images/t1-hero-png.png"])
  assert.equal(fake.prompts.length, 1, "one slot, one graph")
  const picture = pngOf(readFileSync(join(dir, "images/t1-hero-png.png")))
  assert.deepEqual([picture.width, picture.height], [1024, 1024], "the prompt's size reached the graph")

  // What the job left: the plan's input at the hash plan.md recorded, and the picture the server made. Both paths are
  // resolved inside the job by `manifestOf`, and the manifest verifies unchanged.
  const manifest = await manifestOf(dir, [
    { path: fixture.asset, source: "input" },
    ...rendered.outputs.map((path) => ({ path, source: "model" as const })),
  ])
  assert.deepEqual(
    manifest.assets.map((entry) => [entry.path, entry.source]),
    [
      [fixture.asset, "input"],
      ["images/t1-hero-png.png", "model"],
    ],
  )
  assert.equal(manifest.assets[0]?.sha256, fixture.sha256, "the manifest carries the plan's own hash")
  assert.equal(manifest.assets[0]?.bytes, fixture.bytes)
  assert.deepEqual(await verifyManifest(dir, manifest), { ok: true, missing: [], changed: [], outside: [] })

  // The checks and the gate: every required check has a result, none failed, and the only skip is the vision review
  // D13/D21 forbid. The set ships with that absence stated, which is the honest half of B5-T5.
  const results = await adapter.check(ctx, IMAGE_CHECKS)
  const coverage = evaluate(IMAGE_CHECKS, results)
  assert.deepEqual(coverage.invalid, [])
  assert.deepEqual(coverage.failed, [])
  assert.deepEqual(coverage.missing, [])
  assert.deepEqual(coverage.skipped.map((result) => result.id), ["images.vlm"])

  const report = qualityGate({ spec, defs: IMAGE_CHECKS, results, outputs: rendered.outputs })
  assert.equal(report.ship, true, JSON.stringify(report.verdicts))
  assert.match(report.warnings.join("; "), /images\.vlm was skipped/)
  assert.deepEqual(
    report.verdicts.map((verdict) => verdict.id),
    ["checks.contract", "checks.skipped", "images.prompts", "images.outputs"],
  )

  // The same plan and the same chain with one unknown hash. A fresh fake is the point: its log must be empty, not
  // "empty except for the run that succeeded", so "refused rather than silently used" is a number and not a sentence.
  const untrusted = await fakeFor(t)
  const refusedDir = jobDir(t)
  const unknown = parseSpec("images", {
    ...briefed,
    model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: "f".repeat(64) },
  })
  assert.deepEqual(unknown.errors, [])
  assert.ok(unknown.spec !== undefined && unknown.spec.kind === "images")
  if (!unknown.spec || unknown.spec.kind !== "images") return

  await assert.rejects(adapterFor(t, untrusted).prepare(unknown.spec, context(refusedDir)), (error: Error) => {
    assert.match(error.message, /^images: slot "t1-hero-png": /)
    assert.match(error.message, /is not in the model registry, so it is refused/)
    assert.match(error.message, /registerModel\(\{ hash, name, license, territory \}\)/)
    return true
  })
  assert.equal(untrusted.prompts.length, 0, "the refused job sent no /prompt")
  assert.deepEqual(untrusted.requests, [], "the refused job made no request at all")
  assert.equal(existsSync(join(refusedDir, "workflows")), false, "no workflow was written for the refused set")
  assert.equal(existsSync(join(refusedDir, "images")), false, "no picture was written for the refused set")
})

test("no dependency was added for HTTP, WebSocket, multipart or PNG", () => {
  const pkg = JSON.parse(readFileSync(new URL("../packages/artifact/package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["@omacode/sandbox"])

  const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = [...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {}), ...Object.keys(pkg.dependencies ?? {})]
  assert.equal(names.some((name) => /^(ws|comfyui|socket\.io|pngjs|form-data)$/i.test(name)), false)

  // The client names the library it uses, and it is the platform's: no import from a package in its file.
  const source = readFileSync(new URL("../packages/artifact/src/comfyui.ts", import.meta.url), "utf8")
  assert.match(source, /import \{ randomUUID \} from "node:crypto"/)
  assert.doesNotMatch(source, /from "(?!node:)/)
})
