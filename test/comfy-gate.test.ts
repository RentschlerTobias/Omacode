// The ComfyUI MCP gate (src/comfy-gate.ts): which model files a run names, where ComfyUI finds them, their hash
// against the registry, the question the user reads, and the models an approved run registers. Temporary model files
// and a temporary registry stand in; no ComfyUI runs.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { checkRun, DEFAULT_TEMPLATE_CHECKPOINT, DENIED, findModel, hashFile, modelNames, modelRoots, namedModels, questionLines, registerApproved } from "../packages/micromanager/src/comfy-gate.ts"
import { ROLES } from "../packages/state/src/roles.ts"

const ROOT = tempDir("mm-comfygate-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const API_WORKFLOW = {
  "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux-2-klein-4b-Q4_K_M.gguf" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b_fp8_mixed.safetensors", type: "flux2" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "flux2_vae.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "a lighthouse at dawn", clip: ["2", 0] } },
}

test("the model files a workflow names, in API and UI format, and what each run tool names", () => {
  assert.deepEqual(modelNames(API_WORKFLOW), ["flux-2-klein-4b-Q4_K_M.gguf", "qwen_3_4b_fp8_mixed.safetensors", "flux2_vae.safetensors"])
  assert.deepEqual(modelNames({ nodes: [{ type: "CheckpointLoaderSimple", widgets_values: ["sdxl.safetensors"] }, { type: "Note", widgets_values: ["read me"] }] }), ["sdxl.safetensors"])
  const path = join(ROOT, "wf.json")
  writeFileSync(path, JSON.stringify(API_WORKFLOW))
  assert.equal(namedModels("comfy_run_workflow", { workflow_path: path }).models.length, 3)
  assert.match(namedModels("comfy_run_workflow", { workflow_path: join(ROOT, "missing.json") }).unread ?? "", /could not be read/)
  assert.deepEqual(namedModels("comfy_generate_image", { prompt: "x" }).models, [DEFAULT_TEMPLATE_CHECKPOINT])
  assert.deepEqual(namedModels("comfy_generate_image", { prompt: "x", checkpoint: "z.safetensors" }).models, ["z.safetensors"])
  const template = namedModels("comfy_run_template", { name: "flux_dev", params: { ckpt_name: "a.safetensors", seed: 1 } })
  assert.deepEqual(template.models, ["a.safetensors"])
  assert.match(template.unread ?? "", /names its own models/)
})

test("ComfyUI's model folders, with extra_model_paths.yaml, find a file by its name", () => {
  const ws = join(ROOT, "ws")
  const shared = join(ROOT, "shared")
  mkdirSync(join(ws, "models", "vae"), { recursive: true })
  mkdirSync(join(shared, "diffusion_models"), { recursive: true })
  writeFileSync(join(ws, "models", "vae", "flux2_vae.safetensors"), "vae")
  writeFileSync(join(shared, "diffusion_models", "flux-2-klein-4b-Q4_K_M.gguf"), "unet")
  writeFileSync(join(ws, "extra_model_paths.yaml"), `apps:\n  base_path: ${shared}\n  diffusion_models: diffusion_models\n`)
  const roots = modelRoots(ws)
  assert.deepEqual(roots, [join(ws, "models"), join(shared, "diffusion_models")])
  assert.equal(findModel("flux2_vae.safetensors", roots), join(ws, "models", "vae", "flux2_vae.safetensors"))
  assert.equal(findModel("flux-2-klein-4b-Q4_K_M.gguf", roots), join(shared, "diffusion_models", "flux-2-klein-4b-Q4_K_M.gguf"))
  assert.equal(findModel("nowhere.gguf", roots), undefined)
})

test("a hash is computed once per file version", async () => {
  const file = join(ROOT, "h.bin")
  const cache = join(ROOT, "hashes.json")
  writeFileSync(file, "weights")
  const want = createHash("sha256").update("weights").digest("hex")
  assert.equal(await hashFile(file, cache), want)
  assert.match(JSON.stringify(await import("node:fs").then((fs) => JSON.parse(fs.readFileSync(cache, "utf8")))), new RegExp(want))
})

test("unknown models are asked about, not refused; an approved run registers them and the next one runs", async () => {
  const ws = join(ROOT, "ws2")
  const registryDir = join(ROOT, "registry")
  mkdirSync(join(ws, "models", "checkpoints"), { recursive: true })
  writeFileSync(join(ws, "models", "checkpoints", "mine.safetensors"), "my weights")
  const wf = join(ROOT, "wf2.json")
  writeFileSync(wf, JSON.stringify({ "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "mine.safetensors" } } }))
  const o = { workspace: ws, registryDir, cacheFile: join(ROOT, "hashes2.json") }

  const first = await checkRun("comfy_run_workflow", { workflow_path: wf }, o)
  assert.equal(first.clear, false)
  assert.equal(first.models[0]!.verdict.status, "unknown")
  const lines = questionLines(first)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^mine\.safetensors \(sha256 [0-9a-f]{10}…\): no licence or territory registered$/)

  assert.deepEqual(registerApproved(first, { registryDir, when: new Date("2026-11-23") }), ["mine.safetensors"])
  const second = await checkRun("comfy_run_workflow", { workflow_path: wf }, o)
  assert.equal(second.clear, true, "approved once: not asked again")
  assert.equal(second.models[0]!.verdict.status, "allowed")

  const missing = await checkRun("comfy_generate_image", { prompt: "x", checkpoint: "gone.safetensors" }, o)
  assert.match(questionLines(missing)[0]!, /file not found in ComfyUI's model folders/)
  assert.deepEqual(registerApproved(missing, { registryDir }), [], "no file, no hash: nothing to register")
  const template = await checkRun("comfy_run_template", { name: "t", params: {} }, o)
  assert.equal(template.clear, false)
  assert.match(questionLines(template).at(-1)!, /licence not checked$/)
})

test("the denied tools name their reason, and only the designer may use comfy_*", () => {
  for (const tool of ["comfy_partner_generate", "comfy_auth_login", "comfy_launch_comfyui", "comfy_install_node", "comfy_download_model"]) assert.ok(DENIED[tool], tool)
  for (const tool of ["comfy_run_workflow", "comfy_generate_image", "comfy_server_info", "comfy_fetch_outputs"]) assert.equal(DENIED[tool], undefined, tool)
  for (const role of ROLES) {
    const denied = role.rules.some((r) => r.action === "comfy_*" && r.effect === "deny")
    assert.equal(denied, role.id !== "visual", role.agent)
  }
})
