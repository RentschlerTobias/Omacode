// image_models (src/image-models.ts): the families ready on a ComfyUI, in the user's order, from files on disk and the
// model registry. Temporary model files and a temporary registry stand in.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { registerModel } from "../packages/artifact/src/models.ts"
import { imageModels, preferredOrder } from "../packages/micromanager/src/image-models.ts"

const ROOT = tempDir("mm-imagemodels-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

function model(ws: string, kind: string, name: string, registryDir?: string, license = "Apache-2.0") {
  mkdirSync(join(ws, "models", kind), { recursive: true })
  const bytes = Buffer.alloc(1_100_000, name)
  writeFileSync(join(ws, "models", kind, name), bytes)
  if (registryDir) registerModel({ hash: createHash("sha256").update(bytes).digest("hex"), name, license, territory: "world" }, { dir: registryDir })
}

test("the user's order wins, unknown ids are dropped, the rest keep their default place", () => {
  assert.deepEqual(preferredOrder(undefined), ["z-image", "flux2-klein", "qwen-image"])
  assert.deepEqual(preferredOrder({ images: { prefer: ["qwen-image", "nope"] } }), ["qwen-image", "z-image", "flux2-klein"])
})

test("a family is ready only with a permitted diffusion model, text encoder and VAE; its caution travels with it", async () => {
  const ws = join(ROOT, "ws")
  const reg = join(ROOT, "reg")
  model(ws, "diffusion_models", "z_image_turbo_int8_convrot.safetensors", reg)
  model(ws, "text_encoders", "qwen_3_4b_fp8_mixed.safetensors", reg)
  model(ws, "vae", "ae.safetensors", reg)
  model(ws, "diffusion_models", "qwen-image-2.1-Q4_K_M.gguf", reg, "LicenseRef-Qwen-Research")
  model(ws, "text_encoders", "qwen3vl_8b_w4a8.safetensors", reg, "LicenseRef-Qwen-Research")
  model(ws, "vae", "qwen_image_2.1_vae_bf16.safetensors")
  model(ws, "diffusion_models", "flux-2-klein-4b-Q4_K_M.gguf", reg)
  const o = { registryDir: reg, cacheFile: join(ROOT, "hashes.json") }

  const text = await imageModels(ws, { ...o, config: {} })
  assert.match(text, /^1\. Z-Image-Turbo \[z-image\]/m)
  assert.match(text, /text encoder: qwen_3_4b_fp8_mixed\.safetensors · VAE: ae\.safetensors/)
  assert.doesNotMatch(text, /^2\./m, "only one family is ready")
  assert.match(text, /- FLUX\.2-klein 4B \[flux2-klein\]: missing its VAE/)
  assert.match(text, /- Qwen-Image-2\.1 \[qwen-image\]: missing a permitted VAE \(qwen_image_2\.1_vae_bf16\.safetensors is unknown\)/)

  model(ws, "vae", "qwen_image_2.1_vae_bf16.safetensors", reg, "LicenseRef-Qwen-Research")
  const ordered = await imageModels(ws, { ...o, config: { images: { prefer: ["qwen-image"] } } })
  assert.match(ordered, /^1\. Qwen-Image-2\.1 \[qwen-image\]/m)
  assert.match(ordered, /licence: LicenseRef-Qwen-Research — non-commercial only/)
  assert.match(ordered, /^2\. Z-Image-Turbo/m)
  assert.equal((await imageModels(join(ROOT, "empty"), { ...o, config: {} })).includes("No image model is ready"), true)
})
