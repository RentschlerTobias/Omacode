// The image spec (B5-T1) and its ComfyUI-backed adapter (B5-T2). The spec tests are pure: a version 2 image set parses
// with a checkpoint it shares and a checkpoint one slot owns, and every way of getting a model, a ref or a size wrong
// fails at the address the reader has to fix. The client tests run against a real HTTP server on loopback (fake-comfy.ts)
// because a timeout, a 500 and a closed port are things a `Response` stub cannot have; each one is a value and none is a
// throw.
//
// The adapter tests are the same shape as the video's: `prepare` is checked against the files it writes, and `render`
// against the files the fake server produced. The fake can fail a job, refuse a checkpoint by name or return bytes that
// are not a picture, because those are the cases where a silent pass would be worse than a red line.
//
// The last test reads the package manifests: the client is `fetch` and `WebSocket`, and no dependency was added for a
// WebSocket client, a multipart body or a PNG.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

import {
  IMAGE_CHECKS,
  imageAdapter,
  imageWorkflow,
  writeImageProject,
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
import { ComfyClient, type ComfyOptions, type ComfyProgress } from "../packages/artifact/src/comfyui.ts"
import { readPng } from "../packages/artifact/src/png.ts"
import { parseSpec, SPEC_VERSIONS, type ImagesSpec } from "../packages/artifact/src/spec.ts"
import { FakeComfy, type FakeComfyOptions } from "./fake-comfy.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.

const sha = "a".repeat(64)

// A version 2 image set that uses everything B5-T1 added: a checkpoint for the set, a different one for one slot, and
// the seed, negative and refs the contract already had.
const v2 = (): Record<string, unknown> => ({
  kind: "images",
  version: 2,
  job: "job-1",
  brief: "images for the release",
  checks: ["images.contract"],
  model: { name: "SDXL base", file: "sdxl-base.safetensors", sha256: sha },
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
      model: { name: "FLUX schnell", file: "flux1-schnell.safetensors" },
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

const adapterFor = (fake: FakeComfy) =>
  imageAdapter({ comfy: { url: fake.url, pollMs: 5, watchTimeoutMs: 5000 } })

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

  assert.deepEqual(spec.model, { name: "SDXL base", file: "sdxl-base.safetensors", sha256: sha })
  assert.equal(spec.slots[0]?.seed, 7)
  assert.equal(spec.slots[0]?.negative, "text")
  assert.deepEqual(spec.slots[0]?.refs, ["refs/a.png"])
  assert.deepEqual(spec.slots[1]?.model, { name: "FLUX schnell", file: "flux1-schnell.safetensors" })
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

test("a slot with no model and a set with no model is refused at prepare, before any request", async (t) => {
  const fake = await fakeFor(t)
  const dir = jobDir(t)
  const without = v2()
  delete without["model"]
  without["slots"] = [
    { id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } },
    { id: "wide", prompt: "a wide gradient", size: { width: 32, height: 16 } },
  ]
  const spec = parsed(without)
  const adapter = adapterFor(fake)
  const ctx = context(dir)

  await assert.rejects(adapter.prepare(spec, ctx), /slot "hero" has no model and the set declares none, so there is no checkpoint to load/)
  assert.deepEqual(fake.requests, [])
  assert.equal(existsSync(join(dir, "workflows")), false)
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
  const adapter = adapterFor(fake)
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
  assert.deepEqual(results.map((result) => result.status), ["passed", "passed", "passed"], JSON.stringify(results))
  assert.deepEqual(evaluate(IMAGE_CHECKS, results).invalid, [])
})

test("a different checkpoint on one slot gets its own workflow, while the other slot inherits the set's", (t) => {
  const dir = jobDir(t)
  mkdirSync(join(dir, "refs"))
  writeFileSync(join(dir, "refs/a.png"), "a ref the job carries")
  const project: ImageProject = writeImageProject(parsed(v2()), dir)

  assert.deepEqual(
    project.slots.map((slot) => slot.model.name),
    ["SDXL base", "FLUX schnell"],
  )
  assert.notEqual(project.slots[0]?.workflow, project.slots[1]?.workflow)

  const first = JSON.parse(readFileSync(join(dir, project.slots[0]!.workflow), "utf8")) as Record<
    string,
    { inputs: Record<string, unknown> }
  >
  const second = JSON.parse(readFileSync(join(dir, project.slots[1]!.workflow), "utf8")) as Record<
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
    model: { name: "SDXL base", file: "sdxl-base.safetensors" },
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
  const adapter = adapterFor(fake)
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
    model: { name: "SDXL base", file: "sdxl-base.safetensors" },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const adapter = adapterFor(fake)
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
    model: { name: "SDXL base", file: "sdxl-base.safetensors" },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 }, refs: ["refs/link.png"] }],
  })
  const adapter = adapterFor(fake)
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
    model: { name: "SDXL base", file: "sdxl-base.safetensors" },
    slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 64, height: 48 } }],
  })
  const adapter = adapterFor(fake)
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
