// The image_models tool: which image models are ready on this machine's ComfyUI, in the user's order, with the files
// each needs, how to load them, and what their licence allows. An agent calls it before its first picture, so it picks a
// model by what it is good at and what it may be used for, instead of by what happens to be on disk.
//
// The order is the user's: `images.prefer` in omacode.jsonc (family ids), default z-image, flux2-klein, qwen-image
// (2026-11-23). A family is ready when its diffusion model, text encoder and VAE are all on disk and all permitted by
// the model registry (the same check the ComfyUI gate makes before a run, src/comfy-gate.ts).

import { readFileSync } from "node:fs"

import { MODEL_REGISTRY, readModelRegistry, registryWith, resolveModel, type ModelVerdict } from "@omacode/artifact/models"
import { stripComments } from "@omacode/core/jsonc"
import { configFilePath } from "@omacode/core/paths"

import { hashFile, modelFiles, type ModelFile } from "./comfy-gate.ts"

export const IMAGE_MODELS_ID = "image_models"

export interface Family {
  readonly id: string
  readonly title: string
  readonly good: string
  // how the graph loads it (ComfyUI's split loaders) and the settings it was made for
  readonly load: string
  readonly settings: string
  readonly unet: RegExp
  readonly encoder: RegExp
  readonly vae: RegExp
  // said beside the licence when the licence restricts use
  readonly caution?: string
}

export const FAMILIES: readonly Family[] = [
  {
    id: "z-image",
    title: "Z-Image-Turbo",
    good: "fast (8 steps), photorealistic scenes, people, products",
    load: "UNETLoader (diffusion_models) + CLIPLoader type lumina2 (text_encoders) + VAELoader; latent EmptySD3LatentImage",
    settings: "8 steps, cfg 1.0, sampler res_multistep, scheduler simple, 1024×1024 or similar",
    unet: /z[-_ ]?image/i,
    encoder: /qwen_?3_4b/i,
    vae: /^(z_image_)?ae\.safetensors$/i,
  },
  {
    id: "flux2-klein",
    title: "FLUX.2-klein 4B",
    good: "general purpose, illustration and design, editing an existing image",
    load: "UnetLoaderGGUF for .gguf or UNETLoader for .safetensors (diffusion_models) + CLIPLoader type flux2 (text_encoders) + VAELoader; latent EmptyFlux2LatentImage",
    settings: "4 steps for the distilled 4B, cfg 1.0; the base model needs about 20 steps",
    unet: /flux[-_. ]?2/i,
    encoder: /qwen_?3_4b/i,
    vae: /flux2[-_]?vae/i,
  },
  {
    id: "qwen-image",
    title: "Qwen-Image-2.1",
    good: "text and lettering inside the image (posters, signs, slides), complex compositions",
    load: "UnetLoaderGGUF (diffusion_models) + CLIPLoader type qwen_image (text_encoders) + VAELoader; latent EmptySD3LatentImage",
    settings: "about 20 steps, cfg 2.5–4",
    unet: /qwen[-_. ]?image/i,
    encoder: /qwen_?(2\.?5|3)[-_]?vl/i,
    vae: /qwen[-_]?image.*vae/i,
    caution: "non-commercial only (research or evaluation): use it only when the user has said the picture is not for commercial use; otherwise ask the user first, or pick another model",
  },
]

export const DEFAULT_ORDER = ["z-image", "flux2-klein", "qwen-image"] as const

// The user's order: images.prefer in omacode.jsonc; unknown ids are dropped, missing families keep their default place.
export function preferredOrder(config: unknown): string[] {
  const asked = (config as { images?: { prefer?: unknown } } | undefined)?.images?.prefer
  const ids = new Set(FAMILIES.map((f) => f.id))
  const first = Array.isArray(asked) ? asked.filter((x): x is string => typeof x === "string" && ids.has(x)) : []
  return [...new Set([...first, ...DEFAULT_ORDER])]
}

export function readImageConfig(path = configFilePath()): unknown {
  try {
    return JSON.parse(stripComments(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export interface Checked extends ModelFile {
  readonly verdict: ModelVerdict
}

export interface FamilyView {
  readonly family: Family
  readonly unets: readonly Checked[]
  readonly encoder?: Checked
  readonly vae?: Checked
  readonly ready: boolean
  readonly missing: readonly string[]
  readonly licences: readonly string[]
}

const permitted = (c: Checked | undefined) => c?.verdict.status === "allowed"
const licenceOf = (c: Checked): string => (c.verdict.status === "allowed" ? c.verdict.spdx : c.verdict.status)

export function familyViews(files: readonly Checked[], order: readonly string[]): FamilyView[] {
  const byKind = (kinds: string[], re: RegExp) => files.filter((f) => kinds.includes(f.kind) && re.test(f.name))
  return order.map((id) => FAMILIES.find((f) => f.id === id)!).map((family) => {
    const unets = byKind(["diffusion_models", "unet", "checkpoints"], family.unet)
    const encoder = byKind(["text_encoders", "clip"], family.encoder).sort((a, b) => Number(permitted(b)) - Number(permitted(a)))[0]
    const vae = byKind(["vae"], family.vae).sort((a, b) => Number(permitted(b)) - Number(permitted(a)))[0]
    const missing: string[] = []
    if (!unets.some(permitted)) missing.push(unets.length ? "a diffusion model the registry permits" : "a diffusion model")
    if (!permitted(encoder)) missing.push(encoder ? `a permitted text encoder (${encoder.name} is ${encoder.verdict.status})` : "its text encoder")
    if (!permitted(vae)) missing.push(vae ? `a permitted VAE (${vae.name} is ${vae.verdict.status})` : "its VAE")
    const used = [...unets.filter(permitted), ...(encoder ? [encoder] : []), ...(vae ? [vae] : [])]
    return { family, unets, ...(encoder ? { encoder } : {}), ...(vae ? { vae } : {}), ready: missing.length === 0, missing, licences: [...new Set(used.map(licenceOf))] }
  })
}

// What the tool answers: the ready families first in the user's order, then the rest with what they lack.
export function describe(views: readonly FamilyView[]): string {
  const lines = [
    "Image models on this machine's ComfyUI, in the user's order. Pick the first ready one that fits the request; follow its caution if it has one. Use only the files listed here (the ComfyUI gate checks every model a workflow loads).",
    "",
  ]
  let n = 0
  for (const v of views.filter((x) => x.ready)) {
    n++
    lines.push(`${n}. ${v.family.title} [${v.family.id}] — ${v.family.good}`)
    lines.push(`   licence: ${v.licences.join(" + ")}${v.family.caution ? ` — ${v.family.caution}` : ""}`)
    lines.push(`   diffusion model: ${v.unets.filter((u) => u.verdict.status === "allowed").map((u) => u.name).join(" or ")}`)
    lines.push(`   text encoder: ${v.encoder!.name} · VAE: ${v.vae!.name}`)
    lines.push(`   load: ${v.family.load}`)
    lines.push(`   settings: ${v.family.settings}`)
  }
  if (n === 0) lines.push("No image model is ready: say so, and name what is missing below.")
  const rest = views.filter((x) => !x.ready)
  if (rest.length) {
    lines.push("", "Not ready:")
    for (const v of rest) lines.push(`- ${v.family.title} [${v.family.id}]: missing ${v.missing.join(", ")}`)
  }
  lines.push("", "Run it with the comfy MCP tools (tools.comfy.run_workflow with a workflow you wrote, or a template via tools.comfy.run_template), then tools.comfy.fetch_outputs into the project.")
  return lines.join("\n")
}

export async function imageModels(workspace: string, o: { registryDir?: string; cacheFile?: string; config?: unknown } = {}): Promise<string> {
  const registry = registryWith(readModelRegistry(o.registryDir !== undefined ? { dir: o.registryDir } : {}).entries, MODEL_REGISTRY)
  const files: Checked[] = []
  for (const f of modelFiles(workspace)) {
    const hash = await hashFile(f.file, o.cacheFile).catch(() => undefined)
    files.push({ ...f, verdict: resolveModel({ declared: f.name, ...(hash ? { hash } : {}) }, registry) })
  }
  return describe(familyViews(files, preferredOrder(o.config === undefined ? readImageConfig() : o.config)))
}
