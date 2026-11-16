// The image adapter (B5-T1's consumer): an `ImagesSpec` becomes a workflow per slot, each workflow is queued one at a
// time on a ComfyUI server, and the pictures the server produced are fetched back into the job. It shares the client
// with the rest of the package (`comfyui.ts`), so B2b's video graphs talk to the same server through the same rules.
//
// The graph is code, not a spec. `imageWorkflow` is the one template this adapter owns: a checkpoint loader, a positive
// and a negative CLIP encode, an empty latent at the slot's size, a sampler at the slot's seed, a VAE decode and a save
// node. The spec supplies the prompt, the negative, the size, the seed and the model; it cannot add a node, name a
// program, or choose a path outside the job. That is what keeps an images.json from turning into a script.
//
// One render is one slot at a time. A GPU does not become faster by being asked for two graphs at once, and a server
// that runs them in parallel is a server whose memory a caller cannot predict; the queue is the adapter's, not the
// server's.
//
// The checks this round can answer are mechanical: a file for every slot, one file per slot, and the picture's size.
// A VLM review and a checkpoint's territory are B5-T5 and B5-T4, so they are not declared here — a definition that no
// code produces would be a green line or a silent skip pretending to be a look.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import type { Adapter, AdapterContext } from "../adapter.ts"
import { SKIPPED_CODE, type CheckDef, type CheckResult } from "../checks.ts"
import { ComfyClient, type ComfyOptions } from "../comfyui.ts"
import { insidePath } from "../paths.ts"
import { readPng } from "../png.ts"
import type { ImageModel, ImagesSpec, Slot } from "../spec.ts"

// A slot id is a file name inside the job and a filename prefix on the server, so it is held to what both accept
// without quoting. The contract only requires a non-empty string; this is the adapter's own refusal, and it keeps
// `../` and a slash out of every name this file writes or sends.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Where the adapter writes, relative to the job. Both names are its own, so no slot can choose where a byte lands.
const WORKFLOW_DIR = "workflows"
const OUTPUT_DIR = "images"

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)
const many = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Why a checkpoint file is not one this adapter can put in a graph. This repeats the spec's rule for a spec that reached
// the adapter through a cast, and it is lexical for the same reason: the file is resolved by the server, not here.
function checkpointProblem(value: string): string | undefined {
  if (!value) return "is empty"
  if (isAbsolute(value)) return "is absolute, but a checkpoint is resolved inside ComfyUI's own models directory"
  if (value.includes("\\")) return 'uses "\\" as a separator'
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'has an empty, "." or ".." segment'
  }
  return undefined
}

// Why a ref cannot be a file this job may upload. The spec refuses the text; this is the same rule applied to what the
// text names, including a symlink inside the job that resolves out.
function refProblem(value: string): string | undefined {
  if (!value) return "is empty"
  if (isAbsolute(value)) return "is absolute, but a job path is relative to the job directory"
  if (value.includes("\\")) return 'uses "\\" as a separator'
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'has an empty, "." or ".." segment'
  }
  return undefined
}

// The model a slot is made with: its own, else the set's. Returned as it was written, so provenance can record the name
// and the caller can see that the slot inherited rather than invented one.
function modelOf(spec: ImagesSpec, slot: Slot): ImageModel | undefined {
  return slot.model ?? spec.model
}

// Everything that would make the written workflows disagree with the spec or leave the job. One function, so a refusal
// is a sentence and not a half-written job: it runs before the first directory exists.
function imageProblem(spec: ImagesSpec): string | undefined {
  if (spec.kind !== "images") return `it is a ${shown(spec.kind)} spec, not an image set`
  if (spec.slots.length === 0) return "it has no slots, so a render would produce nothing"

  const ids = new Set<string>()
  for (const slot of spec.slots) {
    if (!SAFE_ID.test(slot.id)) return `slot id ${shown(slot.id)} is not a safe file name (${SAFE_ID.source})`
    if (ids.has(slot.id)) return `slot id ${shown(slot.id)} is used twice, and two slots would write one file`
    ids.add(slot.id)

    if (!slot.prompt) return `slot ${shown(slot.id)} has an empty prompt`
    if (!Number.isInteger(slot.size.width) || slot.size.width <= 0 || !Number.isInteger(slot.size.height) || slot.size.height <= 0) {
      return `slot ${shown(slot.id)}: size ${shown(slot.size)} is not two positive integers`
    }
    if (slot.seed !== undefined && !Number.isInteger(slot.seed)) {
      return `slot ${shown(slot.id)}: seed ${shown(slot.seed)} is not an integer`
    }

    const model = modelOf(spec, slot)
    if (model === undefined) {
      return `slot ${shown(slot.id)} has no model and the set declares none, so there is no checkpoint to load`
    }
    if (!model.name) return `slot ${shown(slot.id)}: model name must not be empty`
    if (model.file !== undefined) {
      const problem = checkpointProblem(model.file)
      if (problem) return `slot ${shown(slot.id)}: model file ${shown(model.file)} ${problem}`
    }
    if (model.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(model.sha256)) {
      return `slot ${shown(slot.id)}: model sha256 ${shown(model.sha256)} is not a lowercase sha256 digest`
    }

    for (const ref of slot.refs ?? []) {
      const problem = refProblem(ref)
      if (problem) return `slot ${shown(slot.id)}: ref ${shown(ref)} ${problem}`
    }
  }
  return undefined
}

// A stable seed for a slot that did not give one: the job and the slot id, hashed. A generator needs a number, and a
// number drawn from the clock would make two runs of the same job unreproducible without saying so. A stated seed is
// kept exactly.
function seedFor(job: string, slot: string, stated?: number): number {
  if (stated !== undefined) return stated
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(`${job}/${slot}`, "utf8")) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 2_147_483_647
}

// A part of a job or a model name that is safe in a server-side path. It is only used for ComfyUI's own
// `filename_prefix`; the file the adapter keeps is named from the slot id, which is already restricted.
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "") || "job"
  )
}

// The graph one slot runs. The node ids are the template's own and its shape is fixed; the spec's fields land in
// `inputs` as values, never as keys or node types. `CheckpointLoaderSimple.ckpt_name` is the model's `file` when it has
// one, because that is the name the server resolves; otherwise the human `name` is the only identifier the spec gave.
export interface WorkflowInput {
  readonly model: ImageModel
  readonly prompt: string
  readonly negative: string
  readonly size: { readonly width: number; readonly height: number }
  readonly seed: number
  readonly prefix: string
}

export function imageWorkflow(input: WorkflowInput): Record<string, unknown> {
  const checkpoint = input.model.file ?? input.model.name
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: input.seed,
        steps: 20,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: input.size.width, height: input.size.height, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: input.prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: input.negative, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: input.prefix, images: ["8", 0] } },
  }
}

// One slot as the adapter runs it: the resolved model, the seed that will be written into the graph, the two job-relative
// paths it reads and writes, and the refs the job may upload later. The checks read this rather than the JSON on disk, so
// a slot the writer planned and a slot the check looks for cannot disagree.
export interface ImageSlotPlan {
  readonly id: string
  readonly prompt: string
  readonly negative?: string
  readonly size: { readonly width: number; readonly height: number }
  readonly seed: number
  readonly model: ImageModel
  readonly workflow: string
  readonly output: string
  readonly refs: readonly string[]
}

export interface ImageProject {
  readonly dir: string
  readonly workflows: readonly string[]
  readonly slots: readonly ImageSlotPlan[]
}

// A ref the job points at, checked against the real job. The lexical rule above refused the text; this is that rule
// applied to the file the text names, including a symlink inside the job that resolves out. A ref that is not there is a
// refusal too: a graph that loads it would fail later, after the queue has already been used.
function fileInJob(dir: string, value: string, slot: string): string {
  const target = resolve(dir, value)
  if (!insidePath(dir, target)) {
    throw new Error(`images: slot ${shown(slot)}: ref ${shown(value)} resolves outside the job directory`)
  }
  let info
  try {
    info = statSync(target)
  } catch {
    throw new Error(`images: slot ${shown(slot)}: ref ${shown(value)} is not a file inside the job directory`)
  }
  if (!info.isFile()) throw new Error(`images: slot ${shown(slot)}: ref ${shown(value)} is not a file inside the job directory`)
  return target
}

// Write one workflow per slot and lay out the job. The same spec always writes the same bytes: no clock, no random id, no
// seed this file invented twice. Refusals happen before the first directory is made.
export function writeImageProject(spec: ImagesSpec, jobDir: string): ImageProject {
  const problem = imageProblem(spec)
  if (problem !== undefined) throw new Error(`images: ${problem}`)

  const dir = resolve(jobDir)
  for (const slot of spec.slots) {
    for (const ref of slot.refs ?? []) fileInJob(dir, ref, slot.id)
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const name of [WORKFLOW_DIR, OUTPUT_DIR]) {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  }

  const slots: ImageSlotPlan[] = []
  const workflows: string[] = []
  for (const slot of spec.slots) {
    const model = modelOf(spec, slot)
    if (model === undefined) {
      // `imageProblem` refused this above; the guard keeps the type honest rather than a `!` on a value a cast could
      // have made absent after the check.
      throw new Error(`images: slot ${shown(slot.id)} has no model`)
    }
    const seed = seedFor(spec.job, slot.id, slot.seed)
    const workflow = `${WORKFLOW_DIR}/${slot.id}.json`
    const graph = imageWorkflow({
      model,
      prompt: slot.prompt,
      negative: slot.negative ?? "",
      size: slot.size,
      seed,
      prefix: `omacode/${slug(spec.job)}/${slot.id}`,
    })
    const path = join(dir, workflow)
    writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    workflows.push(workflow)
    slots.push({
      id: slot.id,
      prompt: slot.prompt,
      ...(slot.negative !== undefined ? { negative: slot.negative } : {}),
      size: { width: slot.size.width, height: slot.size.height },
      seed,
      model,
      workflow,
      output: `${OUTPUT_DIR}/${slot.id}.png`,
      refs: [...(slot.refs ?? [])],
    })
  }
  return { dir, workflows, slots }
}

// ---------------------------------------------------------------------------------------------------------------------
// The checks. The definitions are the registry's; the verdicts below are the adapter's, and every one can be reached
// without a server by handing `imageResults` a project and what the job's files look like.

export const IMAGE_CHECKS: readonly CheckDef[] = [
  {
    id: "images.count",
    level: "L1",
    kind: "images",
    title: "the render produced one file per slot",
    run: "argv",
    required: true,
  },
  {
    id: "images.files",
    level: "L1",
    kind: "images",
    title: "every slot's file exists and is a picture",
    run: "argv",
    required: true,
  },
  {
    id: "images.size",
    level: "L1",
    kind: "images",
    title: "every picture is the size its slot asked for",
    run: "argv",
    required: true,
  },
]

// What one slot's output looks like on disk. `present` is the file's existence, which is what the count answers;
// `problem` is why it cannot be used as a picture, which is what the file and size checks answer.
export interface ImageFile {
  readonly slot: string
  readonly path: string
  readonly present: boolean
  readonly width?: number
  readonly height?: number
  readonly problem?: string
}

// Why a slot produced no usable file during the render, kept beside the files so a missing one has a reason and not
// just an absence.
export interface ImageSlotFailure {
  readonly slot: string
  readonly reason: string
}

function measure(dir: string, project: ImageProject): readonly ImageFile[] {
  return project.slots.map((slot): ImageFile => {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(dir, slot.output))
    } catch {
      return { slot: slot.id, path: slot.output, present: false, problem: "is missing" }
    }
    const picture = readPng(new Uint8Array(bytes))
    if ("unsupported" in picture) {
      return { slot: slot.id, path: slot.output, present: true, problem: `is not a picture this package can read: ${picture.unsupported}` }
    }
    return { slot: slot.id, path: slot.output, present: true, width: picture.width, height: picture.height }
  })
}

interface Verdict {
  readonly status: "passed" | "failed" | "skipped"
  readonly text: string
}

const passed = (text: string): Verdict => ({ status: "passed", text })
const failed = (text: string): Verdict => ({ status: "failed", text })
const skipped = (text: string): Verdict => ({ status: "skipped", text })

export interface ImageResultInput {
  readonly spec: ImagesSpec
  readonly project: ImageProject
  readonly files: readonly ImageFile[]
  readonly failures?: readonly ImageSlotFailure[]
}

// The reason a slot has no file, if the render recorded one. A server that answered with an error is the interesting
// part of a missing picture; "missing" alone would send the reader looking at the wrong thing.
function failureOf(input: ImageResultInput, slot: string): string | undefined {
  return input.failures?.find((entry) => entry.slot === slot)?.reason
}

function countVerdict(input: ImageResultInput): Verdict {
  const wanted = input.spec.slots.length
  const present = input.files.filter((file) => file.present)
  if (present.length === wanted) return passed(`${many(present.length, "file")} for ${many(wanted, "slot")}`)
  const missing = input.files.filter((file) => !file.present).map((file) => file.slot)
  return failed(`${many(present.length, "file")} for ${many(wanted, "slot")}; missing: ${missing.join(", ")}`)
}

function filesVerdict(input: ImageResultInput): Verdict {
  const bad = input.files.filter((file) => file.problem !== undefined)
  if (bad.length === 0) return passed(`every one of ${many(input.spec.slots.length, "slot")} has a picture`)
  const parts = bad.map((file) => {
    const reason = failureOf(input, file.slot)
    return `${file.slot} ${file.problem}${reason !== undefined ? ` (${reason})` : ""}`
  })
  return failed(parts.join("; "))
}

function sizeVerdict(input: ImageResultInput): Verdict {
  const unreadable = input.files.filter((file) => file.width === undefined || file.height === undefined)
  if (unreadable.length > 0) {
    const parts = unreadable.map((file) => {
      const reason = failureOf(input, file.slot)
      return `${file.slot}: no size can be read${reason !== undefined ? ` (${reason})` : ""}`
    })
    return failed(parts.join("; "))
  }
  const wrong: string[] = []
  for (const file of input.files) {
    const slot = input.spec.slots.find((entry) => entry.id === file.slot)
    if (slot === undefined) continue
    if (file.width !== slot.size.width || file.height !== slot.size.height) {
      wrong.push(`${file.slot} is ${file.width}×${file.height}, not ${slot.size.width}×${slot.size.height}`)
    }
  }
  if (wrong.length > 0) return failed(wrong.join("; "))
  return passed(`${many(input.files.length, "picture")} at the size ${input.files.length === 1 ? "its slot" : "their slots"} asked for`)
}

function verdictFor(id: string, input: ImageResultInput): Verdict | undefined {
  switch (id) {
    case "images.count":
      return countVerdict(input)
    case "images.files":
      return filesVerdict(input)
    case "images.size":
      return sizeVerdict(input)
    default:
      return undefined
  }
}

// One result per definition, in the order the caller asked. A definition this adapter has no rule for is a skip with
// the reason and never a pass: `images.contract` is the spec parse's (L0, run: "spec"), and a caller that hands it here
// should see that the adapter did not run it rather than a green line hiding the fact.
export function imageResults(input: ImageResultInput, defs: readonly CheckDef[]): readonly CheckResult[] {
  return defs.map((def): CheckResult => {
    const verdict = def.run === "argv" ? verdictFor(def.id, input) : undefined
    if (verdict === undefined) {
      const why =
        def.run === "argv"
          ? `no rule in the image adapter produces ${def.id}`
          : `${def.id} is produced by the spec parse (${def.level}, run: "${def.run}"), not by the image adapter`
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

export interface ImageAdapterOptions {
  // The server to talk to. A remote one needs `allowRemote: true` here, in code; there is no spec field for it.
  readonly comfy?: ComfyOptions
  // How long one slot may wait for the server. Raised by a caller with a slow model, bounded by the client's own
  // default when it is not stated.
  readonly watchTimeoutMs?: number
}

// `Adapter<ImagesSpec>` is the compile-time guard against a deck; the intersection repeats the kind so a caller that
// only holds this type cannot spread a `DeckSpec` into `prepare` without a cast. A headless artifact has no `present`
// and no editor, which the interface already allows for.
export interface ImageAdapter extends Adapter<ImagesSpec> {
  readonly kind: "images"
}

export function imageAdapter(options: ImageAdapterOptions = {}): ImageAdapter {
  const client = new ComfyClient(options.comfy)
  let spec: ImagesSpec | undefined
  let project: ImageProject | undefined
  let failures: ImageSlotFailure[] = []
  let stopping = false
  let watching: AbortController | undefined

  const built = (): ImageProject => {
    if (project === undefined) throw new Error("images: the adapter ran a step before prepare, so there is no project to work on")
    return project
  }

  const asked = (): ImagesSpec => {
    if (spec === undefined) throw new Error("images: the adapter ran check before prepare, so there is no spec to check")
    return spec
  }

  const fail = (slot: string, reason: string, ctx: AdapterContext): void => {
    failures.push({ slot, reason })
    ctx.log(`images: slot ${shown(slot)}: ${reason}`)
  }

  return {
    kind: "images",
    name: "comfyui",
    version: "0.1.0",
    // This adapter runs no program: its one capability is the socket to the server, and the allowlist says so by being
    // empty. `assertAdapter` accepts that only for an adapter that declares `network: true`, which this one does.
    executables: [],
    network: true,

    // Read the spec, refuse a slot with no checkpoint, and write one graph per slot. No request is made here: the
    // server is asked when there is a queue to use, and a job whose refs leave the directory fails before a byte is
    // written, let alone sent.
    async prepare(input, ctx) {
      const refused = client.refusal
      if (refused !== undefined) throw new Error(`images: ${refused}`)
      spec = input
      project = writeImageProject(input, ctx.jobDir)
      failures = []
      stopping = false

      const models = new Set(project.slots.map((slot) => slot.model.file ?? slot.model.name))
      const refs = project.slots.reduce((total, slot) => total + slot.refs.length, 0)
      const notes = [
        `${many(project.slots.length, "slot")} across ${many(models.size, "checkpoint")}, one workflow per slot`,
        client.watchTransport === "ws"
          ? "progress is read from /ws when the server offers it; completion from /history"
          : "no WebSocket client on this host, so progress is read by polling /history",
      ]
      if (refs > 0) {
        notes.push(
          `${many(refs, "ref")} stay inside the job; this text-to-image graph starts from the prompt and does not load them`,
        )
      }
      for (const note of notes) ctx.log(note)
      return { notes }
    },

    // One slot at a time. A refusal from the server is recorded and the loop moves on, so one bad checkpoint does not
    // hide the picture the next slot could still make; `check` is where the missing slot is read, with this reason.
    async render(ctx) {
      const current = built()
      const outputs: string[] = []
      stopping = false
      // A second render of the same job starts from its own results: a slot that failed before and succeeds now must not
      // carry the old reason into the check.
      failures = []

      for (const slot of current.slots) {
        if (stopping || ctx.signal?.aborted) throw new Error("images: the render was cancelled")

        let workflow: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(current.dir, slot.workflow), "utf8"))
          if (!isRecord(parsed)) throw new Error("the file is not a JSON object")
          workflow = parsed
        } catch (error) {
          fail(slot.id, `its workflow ${slot.workflow} could not be read: ${error instanceof Error ? error.message : String(error)}`, ctx)
          continue
        }

        const queued = await client.prompt(workflow)
        if (!queued.ok) {
          fail(slot.id, queued.refused, ctx)
          continue
        }
        ctx.log(`images: slot ${shown(slot.id)} queued as ${queued.value.id}`)

        watching = new AbortController()
        const signal = ctx.signal === undefined ? watching.signal : AbortSignal.any([watching.signal, ctx.signal])
        const watched = await client.watch(queued.value.id, () => {}, {
          signal,
          ...(options.watchTimeoutMs !== undefined ? { timeoutMs: options.watchTimeoutMs } : {}),
        })
        watching = undefined
        if (stopping || ctx.signal?.aborted) throw new Error("images: the render was cancelled")
        if (!watched.ok) {
          fail(slot.id, watched.refused, ctx)
          continue
        }
        if (watched.value.failed) {
          fail(slot.id, `the server failed the job${watched.value.error !== undefined ? `: ${watched.value.error}` : ""}`, ctx)
          continue
        }
        if (watched.value.pending) {
          fail(slot.id, "the job did not finish before the watch timed out", ctx)
          continue
        }
        if (watched.value.images.length === 0) {
          fail(slot.id, "the job finished without producing a picture", ctx)
          continue
        }

        const produced = watched.value.images.find((image) => image.type === "output") ?? watched.value.images[0]!
        const fetched = await client.view(produced)
        if (!fetched.ok) {
          fail(slot.id, fetched.refused, ctx)
          continue
        }
        const picture = readPng(fetched.value)
        if ("unsupported" in picture) {
          fail(slot.id, `the server returned something that is not a PNG this package can read: ${picture.unsupported}`, ctx)
          continue
        }

        // A wrong size is not refused here: the file is a real picture, and `images.size` is the check that says whether
        // it is the picture the slot asked for. Writing it keeps that answer in the report instead of in a missing file.
        const path = join(current.dir, slot.output)
        writeFileSync(path, fetched.value, { mode: 0o600 })
        chmodSync(path, 0o600)
        outputs.push(slot.output)
        ctx.log(`images: slot ${shown(slot.id)} wrote ${slot.output} (${picture.width}×${picture.height})`)
      }

      if (outputs.length === 0) {
        const first = failures[0]
        throw new Error(
          `images: no slot produced a picture${first !== undefined ? `: ${shown(first.slot)}: ${first.reason}` : ""}`,
        )
      }
      return { outputs }
    },

    // The pictures themselves: there is no browser in this adapter, so a snapshot is the files the render wrote. A slot
    // with no usable file has no shot, and `check` is where it is named.
    async snapshot(ctx) {
      const current = built()
      const files = measure(ctx.jobDir, current)
      return {
        shots: files
          .filter((file) => file.problem === undefined)
          .map((file) => ({ path: file.path, label: file.slot })),
      }
    },

    async check(ctx, defs) {
      const current = built()
      return imageResults(
        { spec: asked(), project: current, files: measure(ctx.jobDir, current), failures },
        defs,
      )
    },

    // The way out of a watch that is holding a slot. The client's history poll is what this stops; the server's own job
    // is not killed, because a ComfyUI queue is the server's and this adapter does not pretend to own it.
    cancel() {
      stopping = true
      watching?.abort()
    },
  }
}
