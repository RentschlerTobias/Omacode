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
// server's. A second `render` on the same adapter while one is running is refused with the host runner's own sentence
// ("another run is active"): one program at a time and one graph at a time are the same rule. The cross-process lock
// over a shared GPU is `artifactd`'s and arrives in B6.
//
// The checkpoint is resolved by hash before the first byte of a workflow is written (B5-T4, D18). The model name is a
// label; the file's sha256 (computed here when the file is in the job or in a declared model directory, declared by the
// spec when it is not) is what `models.ts` answers about. An unknown or blocked hash is a refusal, and it happens
// before `prepare` returns, so no request reaches a server and no workflow exists to be edited into one.
//
// The checks are the mechanical ones plus what a file can say about itself (B5-T5): one file per slot, the picture's
// size, the prompt's own words reaching the graph, the set's colour and contrast agreeing, and the checkpoint's name,
// hash and licence still attached. Whether the pixels show what the prompt asked is a vision model's question; no local
// one is configured and D13/D21 refuse a cloud one for a check, so `images.vlm` is declared skippable and skipped with
// that reason, never a green line pretending to be a look.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import type { Adapter, AdapterContext } from "../adapter.ts"
import { SKIPPED_CODE, type CheckDef, type CheckResult } from "../checks.ts"
import { ComfyClient, type ComfyOptions } from "../comfyui.ts"
import { contentWords, missingWords, positiveTextOf, styleOf, styleOutliers, type SlotStyle } from "../image-qa.ts"
import {
  DEFAULT_TERRITORY,
  MODEL_REGISTRY,
  readModelRegistry,
  registryWith,
  resolveModel,
  type ModelRegistry,
  type Territory,
} from "../models.ts"
import { insidePath } from "../paths.ts"
import { readPng, type Rgba } from "../png.ts"
import { sha256File } from "../provenance.ts"
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

// ---------------------------------------------------------------------------------------------------------------------
// The checkpoint (B5-T4).

// What a registry said about one slot's checkpoint, kept beside the slot so a check can compare it with the workflow on
// disk. `verified` is true only when `hash` was computed from a file this machine read; false means it is the spec's
// declaration, which is the weaker fact provenance.ts also keeps apart.
export interface ModelDecision {
  readonly name: string
  readonly hash: string
  readonly spdx: string
  readonly territory: Territory
  readonly territories: readonly Territory[]
  readonly use: string
  readonly verified: boolean
  readonly file?: string
}

// What a caller hands the writer besides the spec: the registry to resolve against, the territory to resolve for (the
// EU unless stated) and the directories a real ComfyUI install keeps its checkpoints in. All three are code, not spec
// fields: an images.json cannot choose which registry judges it or where on the host to look for a file.
export interface ImageProjectOptions {
  readonly registry?: ModelRegistry
  readonly territory?: Territory
  readonly modelDirs?: readonly string[]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// The file a slot's checkpoint names, if this machine has it: inside the job first, then each declared model directory in
// the order it was declared. `model.file` is server-relative, so joining it with the job is the case where the job
// carries its own copy; the model directories are where an installed ComfyUI keeps them.
function checkpointFile(
  model: ImageModel,
  jobDir: string,
  slot: string,
  modelDirs: readonly string[],
): { readonly path: string; readonly inJob: boolean } | undefined {
  if (model.file === undefined) return undefined
  const inJob = resolve(jobDir, model.file)
  if (isFile(inJob)) {
    if (!insidePath(jobDir, inJob)) {
      throw new Error(`images: slot ${shown(slot)}: checkpoint ${shown(model.file)} resolves outside the job directory`)
    }
    return { path: inJob, inJob: true }
  }
  for (const dir of modelDirs) {
    const candidate = resolve(dir, model.file)
    if (isFile(candidate)) return { path: candidate, inJob: false }
  }
  return undefined
}

// Resolve one slot's checkpoint to an allowed decision, or refuse with the policy's own sentence. The file's hash wins
// over the declared one, and a disagreement between them is a refusal rather than a preference: whichever of the two is
// wrong would otherwise travel as provenance.
async function checkpointDecision(
  model: ImageModel,
  slot: string,
  jobDir: string,
  options: ImageProjectOptions,
): Promise<ModelDecision> {
  const located = checkpointFile(model, jobDir, slot, options.modelDirs ?? [])
  let hash = model.sha256
  let verified = false
  if (located !== undefined) {
    const computed = await sha256File(located.path)
    if (model.sha256 !== undefined && model.sha256 !== computed) {
      throw new Error(
        `images: slot ${shown(slot)}: checkpoint ${shown(model.file)} hashes to ${computed}, not the declared ${model.sha256}; a declared hash that disagrees with the bytes is refused`,
      )
    }
    hash = computed
    verified = true
  }
  const territory = options.territory ?? DEFAULT_TERRITORY
  const verdict = resolveModel(
    { declared: model.name, ...(hash !== undefined ? { hash } : {}), territory },
    options.registry ?? MODEL_REGISTRY,
  )
  if (verdict.status !== "allowed") throw new Error(`images: slot ${shown(slot)}: ${verdict.reason}`)
  return {
    name: verdict.name,
    hash: verdict.hash,
    spdx: verdict.spdx,
    territory: verdict.territory,
    territories: verdict.territories,
    use: verdict.use,
    verified,
    ...(located !== undefined ? { file: located.inJob ? (model.file ?? located.path) : located.path } : {}),
  }
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
  // The registry's answer for this slot. Optional in the type because a cast could hand the writer a plan without one,
  // and the provenance check then has a sentence instead of a crash.
  readonly checkpoint?: ModelDecision
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
// seed this file invented twice. Every refusal happens before the first directory is made, and the checkpoints are
// resolved before the first workflow is written: a job whose model is unknown leaves no graph behind for a later step
// to send.
export async function writeImageProject(
  spec: ImagesSpec,
  jobDir: string,
  options: ImageProjectOptions = {},
): Promise<ImageProject> {
  const problem = imageProblem(spec)
  if (problem !== undefined) throw new Error(`images: ${problem}`)

  const dir = resolve(jobDir)
  for (const slot of spec.slots) {
    for (const ref of slot.refs ?? []) fileInJob(dir, ref, slot.id)
  }

  // Decisions first, files second. The graph is built here too, so a checkpoint refusal leaves nothing half-written.
  const prepared: {
    readonly slot: Slot
    readonly model: ImageModel
    readonly checkpoint: ModelDecision
    readonly seed: number
    readonly workflow: string
    readonly graph: Record<string, unknown>
  }[] = []
  for (const slot of spec.slots) {
    const model = modelOf(spec, slot)
    if (model === undefined) {
      // `imageProblem` refused this above; the guard keeps the type honest rather than a `!` on a value a cast could
      // have made absent after the check.
      throw new Error(`images: slot ${shown(slot.id)} has no model`)
    }
    const checkpoint = await checkpointDecision(model, slot.id, dir, options)
    const seed = seedFor(spec.job, slot.id, slot.seed)
    prepared.push({
      slot,
      model,
      checkpoint,
      seed,
      workflow: `${WORKFLOW_DIR}/${slot.id}.json`,
      graph: imageWorkflow({
        model,
        prompt: slot.prompt,
        negative: slot.negative ?? "",
        size: slot.size,
        seed,
        prefix: `omacode/${slug(spec.job)}/${slot.id}`,
      }),
    })
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
  for (const entry of prepared) {
    const path = join(dir, entry.workflow)
    writeFileSync(path, `${JSON.stringify(entry.graph, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    workflows.push(entry.workflow)
    slots.push({
      id: entry.slot.id,
      prompt: entry.slot.prompt,
      ...(entry.slot.negative !== undefined ? { negative: entry.slot.negative } : {}),
      size: { width: entry.slot.size.width, height: entry.slot.size.height },
      seed: entry.seed,
      model: entry.model,
      checkpoint: entry.checkpoint,
      workflow: entry.workflow,
      output: `${OUTPUT_DIR}/${entry.slot.id}.png`,
      refs: [...(entry.slot.refs ?? [])],
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
  {
    id: "images.prompt",
    level: "L1",
    kind: "images",
    title: "every word a prompt asks for reaches its workflow",
    run: "argv",
    required: true,
  },
  {
    id: "images.provenance",
    level: "L1",
    kind: "images",
    title: "every slot carries the checkpoint, hash and licence that made it",
    run: "argv",
    required: true,
  },
  {
    id: "images.style",
    level: "L2",
    kind: "images",
    title: "the set looks like one set: colour and contrast agree",
    run: "argv",
    required: true,
  },
  {
    id: "images.vlm",
    level: "L2",
    kind: "images",
    title: "a vision model looked at the pictures",
    run: "argv",
    required: true,
    // Skippable by declaration, like the deck's and the video's vision review: the only vision engine the stack can
    // drive is a cloud model, and D13/D21 forbid calling one for a check. The gate treats the skip as a warning, so a
    // set ships with the absence stated instead of a green line standing in for a look.
    skippable: true,
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

const NO_VISION_MODEL =
  "no local vision model is configured, and a cloud model is not called for an image check (D13/D21)"

// Read one slot's workflow back from the job. A workflow that cannot be read is a failure of whichever check asked, with
// this sentence: `prepare` wrote the file, and a check that cannot see it is not looking at the render.
function readWorkflow(dir: string, path: string): { readonly graph?: Record<string, unknown>; readonly problem?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, path), "utf8"))
  } catch (error) {
    return { problem: `${path} could not be read (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!isRecord(parsed)) return { problem: `${path} is not a JSON object` }
  return { graph: parsed }
}

// The checkpoint a workflow's loader names, read the way the server reads it.
function checkpointNameOf(graph: Record<string, unknown>): string | undefined {
  for (const node of Object.values(graph)) {
    if (!isRecord(node) || node["class_type"] !== "CheckpointLoaderSimple") continue
    const inputs = node["inputs"]
    if (isRecord(inputs) && typeof inputs["ckpt_name"] === "string") return inputs["ckpt_name"]
  }
  return undefined
}

// The prompt checklist (B5-T5). The content words of the prompt the author wrote have to be in the positive text the
// graph carries. "The picture shows them" is the vision review's question and is skipped; "the server was asked for
// them" is a fact about two files, and it is the failure that is invisible in a report and obvious in the picture.
function promptVerdict(input: ImageResultInput): Verdict {
  const problems: string[] = []
  let words = 0
  for (const slot of input.project.slots) {
    words += contentWords(slot.prompt).length
    const read = readWorkflow(input.project.dir, slot.workflow)
    if (read.graph === undefined) {
      problems.push(`${slot.id}: ${read.problem}`)
      continue
    }
    const positive = positiveTextOf(read.graph)
    if (positive === undefined) {
      problems.push(`${slot.id}: its workflow has no positive prompt to check`)
      continue
    }
    const missing = missingWords(slot.prompt, positive)
    if (missing.length > 0) problems.push(`${slot.id} asked for ${missing.join(", ")}, which its workflow does not carry`)
  }
  if (problems.length > 0) return failed(problems.join("; "))
  return passed(`${many(words, "prompt word")} from ${many(input.project.slots.length, "prompt")} reach their workflows`)
}

// Provenance presence (B5-T5): every slot's checkpoint is still the one a registry allowed, with the name, hash,
// licence and territory that decision carried, and the workflow on disk still names it. A rewritten workflow is the
// interesting case: the plan says SDXL and the graph says something nobody resolved.
function provenanceVerdict(input: ImageResultInput): Verdict {
  const problems: string[] = []
  for (const slot of input.project.slots) {
    const checkpoint = slot.checkpoint
    if (checkpoint === undefined) {
      problems.push(`${slot.id} has no resolved checkpoint`)
      continue
    }
    if (!/^[0-9a-f]{64}$/.test(checkpoint.hash)) problems.push(`${slot.id} has no sha256 for its checkpoint`)
    if (!checkpoint.name) problems.push(`${slot.id} has no checkpoint name`)
    if (!checkpoint.spdx) problems.push(`${slot.id} has no licence for its checkpoint`)
    if (!(checkpoint.territories.includes(checkpoint.territory) || checkpoint.territories.includes("world"))) {
      problems.push(`${slot.id}'s licence does not permit ${checkpoint.territory}`)
    }
    const read = readWorkflow(input.project.dir, slot.workflow)
    if (read.graph === undefined) {
      problems.push(`${slot.id}: ${read.problem}`)
      continue
    }
    const named = checkpointNameOf(read.graph)
    const wanted = slot.model.file ?? slot.model.name
    if (named !== wanted) problems.push(`${slot.id}'s workflow loads ${shown(named)}, not ${shown(wanted)}`)
  }
  if (problems.length > 0) return failed(problems.join("; "))
  const hashes = new Set(input.project.slots.map((slot) => slot.checkpoint?.hash))
  return passed(
    `${many(hashes.size, "checkpoint")} named with a hash, a licence and a territory, and still the one each workflow loads`,
  )
}

// The set's own look (B5-T5): a 4×4×4 colour histogram and two luma numbers per picture, compared with the slot that
// best represents the set. Deterministic and cheap; `image-qa.ts` owns the arithmetic and the thresholds.
function styleVerdict(input: ImageResultInput): Verdict {
  const problems: string[] = []
  const styles: SlotStyle[] = []
  for (const file of input.files) {
    if (!file.present) continue
    let picture: Rgba
    try {
      const decoded = readPng(new Uint8Array(readFileSync(join(input.project.dir, file.path))))
      if ("unsupported" in decoded) {
        problems.push(`${file.slot} is not a picture this package can read: ${decoded.unsupported}`)
        continue
      }
      picture = decoded
    } catch (error) {
      problems.push(`${file.slot} could not be read (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    styles.push({ slot: file.slot, style: styleOf(picture) })
  }
  if (problems.length > 0) return failed(problems.join("; "))
  if (styles.length < 2) return passed("fewer than two pictures, so there is no set to compare")
  const outliers = styleOutliers(styles)
  if (outliers.length > 0) return failed(outliers.map((entry) => `${entry.slot} does not fit the set: ${entry.why}`).join("; "))
  return passed(`${many(styles.length, "picture")} share one palette and one brightness`)
}

function verdictFor(id: string, input: ImageResultInput): Verdict | undefined {
  switch (id) {
    case "images.count":
      return countVerdict(input)
    case "images.files":
      return filesVerdict(input)
    case "images.size":
      return sizeVerdict(input)
    case "images.prompt":
      return promptVerdict(input)
    case "images.provenance":
      return provenanceVerdict(input)
    case "images.style":
      return styleVerdict(input)
    case "images.vlm":
      return skipped(NO_VISION_MODEL)
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
  // The territory checkpoints are resolved for. The EU unless a caller says otherwise, which is the user's own
  // territory and D3's first named one.
  readonly territory?: Territory
  // Where a checkpoint file may be found to hash it when the job does not carry it: a ComfyUI models directory, in the
  // order the caller declares. Read only; the adapter writes nothing outside the job.
  readonly modelDirs?: readonly string[]
  // A table to resolve against instead of the code-owned one. It exists for a caller that has its own records (and for
  // tests); the adapter still reads the user's registry file and puts those entries in front of it.
  readonly registry?: ModelRegistry
  // Where the user's registry file is. The per-user state directory unless a caller says otherwise.
  readonly registryDir?: string
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
  // A render slot, not a queue: the second caller is told a run is active rather than waiting behind a GPU whose memory
  // they will both be charged for. Cleared in `finally`, so a refusal or a cancellation frees it.
  let rendering = false
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

  // One slot at a time, and every refusal from the server recorded so the next slot can still run. The loop is a
  // closure rather than a method so `render` can hold the single render slot in a `try`/`finally` without the body
  // being a second entry point.
  const renderOnce = async (ctx: AdapterContext): Promise<{ readonly outputs: readonly string[] }> => {
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
  }

  return {
    kind: "images",
    name: "comfyui",
    version: "0.1.0",
    // This adapter runs no program: its one capability is the socket to the server, and the allowlist says so by being
    // empty. `assertAdapter` accepts that only for an adapter that declares `network: true`, which this one does.
    executables: [],
    network: true,

    // Read the spec, resolve every slot's checkpoint by hash, and write one graph per slot. No request is made here: the
    // server is asked when there is a queue to use, and a job whose refs leave the directory or whose checkpoint is
    // unknown fails before a byte is written, let alone sent.
    async prepare(input, ctx) {
      const refused = client.refusal
      if (refused !== undefined) throw new Error(`images: ${refused}`)
      // The user's own registry first. A file that cannot be read is a refusal, not an empty list: a hand-edited entry
      // that lost its licence must not be silently read as "no restrictions recorded".
      const registered = readModelRegistry(options.registryDir !== undefined ? { dir: options.registryDir } : {})
      if (registered.errors.length > 0) {
        throw new Error(`images: the model registry cannot be read, so no checkpoint is allowed: ${registered.errors.join("; ")}`)
      }
      spec = input
      project = await writeImageProject(input, ctx.jobDir, {
        registry: registryWith(registered.entries, options.registry ?? MODEL_REGISTRY),
        ...(options.territory !== undefined ? { territory: options.territory } : {}),
        ...(options.modelDirs !== undefined ? { modelDirs: options.modelDirs } : {}),
      })
      failures = []
      stopping = false

      const models = new Set(project.slots.map((slot) => slot.model.file ?? slot.model.name))
      const refs = project.slots.reduce((total, slot) => total + slot.refs.length, 0)
      const territory = options.territory ?? DEFAULT_TERRITORY
      const declarations = project.slots.filter((slot) => slot.checkpoint?.verified !== true).length
      const notes = [
        `${many(project.slots.length, "slot")} across ${many(models.size, "checkpoint")}, one workflow per slot`,
        `every checkpoint was resolved by sha256 for use in ${territory}; ${
          declarations === 0
            ? "all were hashed from a file on this machine"
            : `${many(declarations, "hash")} came from the spec because the file is not here`
        }`,
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

    // One slot at a time (the loop is `renderOnce`; a refusal from the server is recorded and the loop moves on, so one
    // bad checkpoint does not hide the picture the next slot could still make), and one render at a time (B5-T6): a
    // second call while this one
    // is in flight is refused with the host runner's own sentence instead of queueing a second graph on the same GPU.
    // `artifactd`'s lock is the cross-process half of this and arrives in B6.
    async render(ctx) {
      if (rendering) throw new Error("images: another run is active")
      rendering = true
      try {
        return await renderOnce(ctx)
      } finally {
        rendering = false
      }
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
