// The ComfyUI MCP server (comfy-mcp, Comfy-Org) under the plugin's eye, in every session: build, plan, the
// micromanager's workers and the user's own. OpenCode hands each MCP tool call to the permission hook as
// `comfy_<tool>` with the tool's input in `metadata.input` (spike, opencode 2.2.5, 2026-11-23), so the hook can read the
// workflow before it runs:
//
// - Tools that would spend money, sign in to Comfy Cloud, download or install, or start and stop ComfyUI (which
//   omacode-services does) are denied, with the reason.
// - OpenCode's plan agent may not generate at all: generating is acting, plan is not.
// - A run (run_workflow, generate_image, run_template) is checked against the model registry (@omacode/artifact
//   models.ts) by the sha256 of every model file the workflow names. All known and permitted for the territory: it
//   runs. Anything else (an unknown hash, a licence that does not permit the territory, a blocked model, a template
//   whose models cannot be read before it runs) is put to the user as a permission question that says what is missing,
//   instead of a refusal. An approved run registers its unknown models as approved by the user, licence unverified, so
//   the same file is not asked about again; a blocked model is never registered.
//
// Every run is journalled with the models it loaded, their hashes and licences, and who allowed it.

import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import { DEFAULT_TERRITORY, readModelRegistry, registerModel, registryWith, resolveModel, MODEL_REGISTRY, type ModelVerdict } from "@omacode/artifact/models"
import { userStateDir } from "@omacode/core/paths"

export const COMFY_PREFIX = "comfy_"
export const RUN_TOOLS = new Set(["comfy_run_workflow", "comfy_generate_image", "comfy_run_template"])

// What the plugin never lets through comfy-mcp, by tool, with the reason the model reads.
export const DENIED: Readonly<Record<string, string>> = {
  comfy_partner_generate: "paid partner models (Comfy credits) are off; run a local workflow instead",
  comfy_emit_partner_workflow: "paid partner models (Comfy credits) are off",
  comfy_list_partner_models: "paid partner models (Comfy credits) are off",
  comfy_partner_model_schema: "paid partner models (Comfy credits) are off",
  comfy_auth_login: "no Comfy Cloud sign-in from an agent",
  comfy_launch_comfyui: "omacode-services starts ComfyUI on the first request; just run the workflow",
  comfy_stop_comfyui: "omacode-services stops ComfyUI after its idle time; /services switches it",
  comfy_restart_comfyui: "omacode-services runs ComfyUI; ask the user to switch it in /services",
  comfy_update_comfyui: "ComfyUI is pinned by the installer; the user updates it",
  comfy_switch_comfyui_version: "ComfyUI is pinned by the installer; the user changes it",
  comfy_install_node: "custom nodes are installed by the user, not by an agent",
  comfy_download_model: "models are downloaded by the user, with their licence read first",
  comfy_download: "models are downloaded by the user, with their licence read first",
}

const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i

// Every model file a workflow names: a string value ending in a model file's extension, anywhere in the graph. Works for
// both of ComfyUI's formats (API: inputs.ckpt_name; UI export: widgets_values), and for custom loaders, because the
// file name is what a loader takes whatever its input is called.
export function modelNames(value: unknown, out = new Set<string>()): string[] {
  if (typeof value === "string") {
    if (MODEL_FILE.test(value.trim())) out.add(value.trim())
  } else if (Array.isArray(value)) {
    for (const v of value) modelNames(v, out)
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) modelNames(v, out)
  }
  return [...out]
}

// ComfyUI's default text-to-image template (comfy-mcp generate_image without a checkpoint).
export const DEFAULT_TEMPLATE_CHECKPOINT = "v1-5-pruned-emaonly-fp16.safetensors"

export interface Named {
  readonly models: readonly string[]
  // What could not be read before the run: said to the user in the question.
  readonly unread?: string
}

// The model files a run tool's input names.
export function namedModels(tool: string, input: Record<string, unknown>): Named {
  if (tool === "comfy_run_workflow") {
    const path = typeof input.workflow_path === "string" ? input.workflow_path : ""
    try {
      return { models: modelNames(JSON.parse(readFileSync(path, "utf8"))) }
    } catch {
      return { models: [], unread: `the workflow ${path || "(no path)"} could not be read` }
    }
  }
  if (tool === "comfy_generate_image") {
    const ckpt = typeof input.checkpoint === "string" && input.checkpoint.trim() ? input.checkpoint.trim() : DEFAULT_TEMPLATE_CHECKPOINT
    return { models: [ckpt] }
  }
  const named = modelNames(input.params)
  return { models: named, unread: `the template ${String(input.name ?? "")} names its own models, which are not read before it runs` }
}

// Where ComfyUI finds a model by its file name: <workspace>/models/<kind>/ and the folders extra_model_paths.yaml adds.
export function modelRoots(workspace: string): string[] {
  const roots = [join(workspace, "models")]
  try {
    const yaml = readFileSync(join(workspace, "extra_model_paths.yaml"), "utf8")
    let base = ""
    for (const line of yaml.split("\n")) {
      const m = /^\s+([a-z_]+):\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      if (m[1] === "base_path") base = m[2]!
      else if (base) roots.push(join(base, m[2]!))
    }
  } catch {
    // no extra paths
  }
  return roots
}

export function findModel(name: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const direct = join(root, name)
    if (existsSync(direct) && statSync(direct).isFile()) return direct
    // models/<kind>/<name>: the kind folders sit one level under models/
    let kinds: string[] = []
    try {
      kinds = readdirSync(root)
    } catch {
      continue
    }
    for (const kind of kinds) {
      const file = join(root, kind, name)
      try {
        if (statSync(file).isFile()) return file
      } catch {
        // not in this kind
      }
    }
  }
  return undefined
}

// sha256 of a model file, cached by path, size and mtime: a GGUF of several GB takes seconds to hash, once.
export async function hashFile(file: string, cacheFile = join(userStateDir(), "model-hashes.json")): Promise<string> {
  const st = statSync(file)
  const key = `${file}|${st.size}|${st.mtimeMs}`
  let cache: Record<string, string> = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, string>
  } catch {
    cache = {}
  }
  if (cache[key]) return cache[key]!
  const hash = createHash("sha256")
  await new Promise<void>((done, fail) => {
    createReadStream(file).on("data", (c) => hash.update(c)).on("end", () => done()).on("error", fail)
  })
  const digest = hash.digest("hex")
  cache[key] = digest
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1) + "\n")
  return digest
}

export interface ModelCheck {
  readonly name: string
  readonly file?: string
  readonly hash?: string
  readonly verdict: ModelVerdict
}

export interface RunCheck {
  readonly models: readonly ModelCheck[]
  readonly unread?: string
  // Every model known and permitted, and nothing unread.
  readonly clear: boolean
}

export async function checkRun(tool: string, input: Record<string, unknown>, o: { workspace: string; registryDir?: string; cacheFile?: string }): Promise<RunCheck> {
  const named = namedModels(tool, input)
  const roots = modelRoots(o.workspace)
  const own = readModelRegistry(o.registryDir !== undefined ? { dir: o.registryDir } : {})
  const registry = registryWith(own.entries, MODEL_REGISTRY)
  const models: ModelCheck[] = []
  for (const name of named.models) {
    const file = findModel(name, roots)
    const hash = file ? await hashFile(file, o.cacheFile).catch(() => undefined) : undefined
    const verdict = resolveModel({ declared: name, ...(hash ? { hash } : {}), territory: DEFAULT_TERRITORY }, registry)
    models.push({ name, ...(file ? { file } : {}), ...(hash ? { hash } : {}), verdict })
  }
  const clear = !named.unread && models.every((m) => m.verdict.status === "allowed")
  return { models, ...(named.unread ? { unread: named.unread } : {}), clear }
}

// The lines the user reads in the permission question: one per model that is not cleared, and what could not be read.
export function questionLines(check: RunCheck): string[] {
  const lines: string[] = []
  for (const m of check.models) {
    if ((m.verdict.status === "allowed")) continue
    const short = m.hash ? ` (sha256 ${m.hash.slice(0, 10)}…)` : m.file ? "" : " (file not found in ComfyUI's model folders)"
    const why = m.verdict.status === "blocked" ? `BLOCKED: ${m.verdict.reason}` : m.verdict.status === "territory" ? `licence does not permit ${DEFAULT_TERRITORY}: ${m.verdict.reason}` : "no licence or territory registered"
    lines.push(`${m.name}${short}: ${why}`)
  }
  if (check.unread) lines.push(`${check.unread}: licence not checked`)
  return lines
}

// After a run the user approved: its unknown models become "approved by the user, licence unverified". A blocked model
// or one without a hash is not registered; the journal still says it ran.
export function registerApproved(check: RunCheck, o: { registryDir?: string; when?: Date } = {}): string[] {
  const done: string[] = []
  const day = (o.when ?? new Date()).toISOString().slice(0, 10)
  for (const m of check.models) {
    if (m.verdict.status !== "unknown" || !m.hash) continue
    try {
      registerModel(
        { hash: m.hash, name: m.name, license: "LicenseRef-unverified-user-approved", territory: DEFAULT_TERRITORY, use: `approved by the user in OpenCode on ${day}; the licence was not checked` },
        o.registryDir !== undefined ? { dir: o.registryDir } : {},
      )
      done.push(m.name)
    } catch {
      // blocked by name, or the registry file is broken: left to the user
    }
  }
  return done
}

// A paid partner node in a local workflow: comfy-mcp unlocks it with confirm_spend.
export const spends = (input: Record<string, unknown>): boolean => input.confirm_spend === true

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode's own image tool: a cloud image model of a connected provider, no registry, possibly paid. ComfyUI comes
// first; the cloud tool is the fallback when ComfyUI cannot run here or failed in this session.

export const CLOUD_IMAGE_TOOL = "experimental_image_generate"

export const PREFER_COMFY =
  "ComfyUI runs locally here and comes first: call image_models to pick a model, then the comfy MCP tools (tools.comfy.run_workflow with a workflow for that model, or tools.comfy.run_template; search the catalog for comfy if they are not listed). This cloud tool is the fallback when ComfyUI fails"

export interface ComfyState {
  // the comfyui service of omacode-services, as its status file says
  readonly service?: { readonly mode: string; readonly state: string }
  // whether opencode.json has an enabled comfy MCP server
  readonly mcp: boolean
}

// Whether ComfyUI can take an image request in this session; when not, why (said in the journal).
export function comfyAvailable(s: ComfyState): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (!s.mcp) return { ok: false, why: "no comfy MCP server is configured" }
  if (!s.service) return { ok: false, why: "omacode-services runs no ComfyUI" }
  if (s.service.mode === "off") return { ok: false, why: "ComfyUI is switched off in /services" }
  if (s.service.state === "failed") return { ok: false, why: "ComfyUI failed to start" }
  return { ok: true }
}

// An enabled `comfy` server in OpenCode's config (mcp.servers.comfy, or the older mcp.comfy).
export function comfyMcpConfigured(config: unknown): boolean {
  const mcp = (config as { mcp?: Record<string, unknown> } | undefined)?.mcp
  const servers = (mcp?.servers ?? mcp) as Record<string, { disabled?: boolean; enabled?: boolean } | undefined> | undefined
  const comfy = servers?.comfy
  return Boolean(comfy) && comfy!.disabled !== true && comfy!.enabled !== false
}

// A run the user turned down is not a failure to fall back from: the cloud must not undo the user's no.
export function isRejection(error: unknown): boolean {
  return /reject|denied|not allowed|permission/i.test(String((error as { message?: unknown } | undefined)?.message ?? error ?? ""))
}

// Every model file ComfyUI can load: real path, the name a loader takes, and the kind folder it sits in
// (diffusion_models, text_encoders, vae, …). One entry per real file, links followed.
export interface ModelFile {
  readonly file: string
  readonly name: string
  readonly kind: string
}

export function modelFiles(workspace: string): ModelFile[] {
  const found = new Map<string, ModelFile>()
  for (const root of modelRoots(workspace)) {
    const walk = (dir: string, kind: string, depth: number) => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const n of names) {
        const p = join(dir, n)
        let st
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (st.isDirectory() && depth < 2) walk(p, depth === 0 ? n : kind, depth + 1)
        else if (st.isFile() && MODEL_FILE.test(n) && st.size > 1_000_000) {
          const real = realpathSync(p)
          if (!found.has(real)) found.set(real, { file: real, name: n, kind: kind || basename(root) })
        }
      }
    }
    walk(root, "", 0)
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
