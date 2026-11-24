// The optional creative tools install.sh offers after the plugin (roadmap A6-T6/T7): HyperFrames for decks and video,
// Manim for math animations, ComfyUI for images. Each is found or not, and each can be installed at a pinned version
// under the user's omacode data directory (<data>/tools), never system-wide and never as a new folder in the home:
//
//   omacode tools status                       what is there, and which version
//   omacode tools gpus                         where ComfyUI could run: NVIDIA, an AMD GPU ROCm can use, the CPU
//   omacode tools install <tool> [--gpu <id>]  install one; ComfyUI on the GPU picked (default: the first one found)
//
// This module only plans: it detects, and turns an install into the commands to run, so the plan is testable and the
// CLI can run the steps with their output on the terminal (a ComfyUI install takes minutes and several GB).
//
// Pins (2026-11-23): Manim 0.22.1 (2026-10-27), comfy-cli 1.25.0 (2026-11-03), ComfyUI 0.44.2 (2026-11-06), all older
// than two weeks. HyperFrames 0.9.54 (2026-11-15) is younger: it is the version the deck and video adapters are tested
// against (B3), kept by the user's decision. Licences: HyperFrames Apache-2.0, Manim MIT, comfy-cli and ComfyUI
// GPL-3.0 (separate programs the plugin talks to over HTTP or argv, not linked). comfy-mcp 0.10.0 (Comfy-Org, AGPL-3.0-or-later or a commercial licence)
// is the MCP server agents use to run ComfyUI workflows (src/comfy-gate.ts keeps it in check); it is a separate program
// OpenCode starts, registered in opencode.json under mcp.servers.comfy.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { userDataDir } from "@omacode/core/paths"

import type { Exec } from "./worktree/git.ts"

export const PINS = { hyperframes: "0.9.54", manim: "0.22.1", comfyCli: "1.25.0", comfyui: "0.44.2", comfyMcp: "0.10.0" } as const
export const TOOL_NAMES = ["hyperframes", "manim", "comfyui", "comfy-mcp"] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export const TOOL_INFO: Readonly<Record<ToolName, { readonly title: string; readonly what: string; readonly size: string }>> = {
  hyperframes: { title: "HyperFrames", what: "decks and videos from HTML (the deck and video adapters)", size: "about 300 MB, Chromium on first use" },
  manim: { title: "Manim", what: "math animations (without LaTeX: formulas need a TeX install of your own)", size: "about 200 MB" },
  comfyui: { title: "ComfyUI", what: "images from local models (the image adapter); no model is downloaded", size: "4–8 GB with PyTorch" },
  "comfy-mcp": { title: "comfy-mcp", what: "lets agents run ComfyUI workflows, checked by the plugin (needs ComfyUI; AGPL-3.0-or-later)", size: "about 100 MB" },
}

export interface Found {
  readonly name: ToolName
  readonly found: boolean
  readonly version?: string
  readonly where?: string
  readonly note?: string
}

export interface Home {
  readonly home: string
  // The user's omacode data directory: what this module installs goes under its tools/, never into the home itself.
  readonly data: string
  readonly env: NodeJS.ProcessEnv
  // /sys and /dev, moved for tests
  readonly sys: string
  readonly dev: string
}

export function home(env: NodeJS.ProcessEnv = process.env): Home {
  return { home: env.HOME || homedir(), data: userDataDir(), env, sys: "/sys", dev: "/dev" }
}

export const toolsDir = (h: Home): string => join(h.data, "tools")
export const hyperframesPrefix = (h: Home): string => join(toolsDir(h), "hyperframes")
// Where an install puts ComfyUI: COMFYUI_WORKSPACE, else the tools directory.
export const comfyWorkspace = (h: Home): string => h.env.COMFYUI_WORKSPACE || join(toolsDir(h), "comfyui")
// Where a ComfyUI may already be, installed by hand or by comfy-cli's default: found, it is offered instead of a
// second install (one is GB of PyTorch).
export const comfyCandidates = (h: Home): string[] =>
  [...new Set([comfyWorkspace(h), join(h.home, "Apps", "ComfyUI"), join(h.home, "ComfyUI"), join(h.home, "comfy", "ComfyUI")])]
const comfyVersion = (dir: string): string | undefined => {
  try {
    return /"([^"]+)"/.exec(readFileSync(join(dir, "comfyui_version.py"), "utf8"))?.[1]
  } catch {
    return undefined
  }
}
const localBin = (h: Home): string => join(h.home, ".local", "bin")

const version = (text: string): string | undefined => /\bv?(\d+\.\d+(?:\.\d+)?(?:[-.a-z0-9]*)?)/i.exec(text)?.[1]

export async function detect(run: Exec, h: Home = home()): Promise<Found[]> {
  const cwd = h.home
  const ask = async (cmd: string, args: string[]) => {
    const r = await run(cmd, args, { cwd, timeoutMs: 30_000 }).catch(() => undefined)
    return r && r.code === 0 ? version(`${r.stdout}\n${r.stderr}`) : undefined
  }
  const hf = await ask("hyperframes", ["--version"])
  const manim = await ask("manim", ["--version"])
  const workspace = comfyCandidates(h).find((dir) => comfyVersion(dir))
  const comfy = workspace ? comfyVersion(workspace) : undefined
  // comfy-mcp starts an MCP server when run, so it is found in uv's tool list rather than by asking it.
  const uvTools = await run("uv", ["tool", "list"], { cwd, timeoutMs: 30_000 }).catch(() => undefined)
  const mcp = uvTools && uvTools.code === 0 ? /^comfy-mcp v(\S+)/m.exec(uvTools.stdout)?.[1] : undefined
  return [
    { name: "hyperframes", found: Boolean(hf), ...(hf ? { version: hf } : {}) },
    { name: "manim", found: Boolean(manim), ...(manim ? { version: manim } : {}) },
    { name: "comfyui", found: Boolean(comfy), ...(comfy ? { version: comfy, where: workspace } : {}) },
    { name: "comfy-mcp", found: Boolean(mcp), ...(mcp ? { version: mcp } : {}) },
  ]
}

// Where ComfyUI could run. The comfy-cli flag for each, and a note for what is not certain.
export interface Gpu {
  readonly id: "nvidia" | "amd" | "amd-igpu" | "cpu"
  readonly name: string
  readonly flags: readonly string[]
  // Set for the integrated Radeons: they share the system RAM, and ROCm's PyTorch for them is a preview.
  readonly note?: string
  // Environment to try when PyTorch does not see the device as it is: an integrated Radeon as its discrete family.
  readonly env?: Readonly<Record<string, string>>
}

// gfx targets of AMD's APUs (integrated graphics): 10.3.5/6 (Rembrandt, Raphael), 11.0.3 (Phoenix), 11.5.x (Strix).
const APU_GFX = new Set([100305, 100306, 110003, 110500, 110501, 110502])
// What the integrated Radeons run as where ROCm's PyTorch has no kernels of their own: the nearest discrete family.
const GFX_OVERRIDE: Readonly<Record<number, string>> = { 100305: "10.3.0", 100306: "10.3.0", 110003: "11.0.0", 110500: "11.0.0", 110501: "11.0.0", 110502: "11.0.0" }

export async function gpus(run: Exec, h: Home = home()): Promise<Gpu[]> {
  const out: Gpu[] = []
  const nv = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { cwd: h.home, timeoutMs: 15_000 }).catch(() => undefined)
  if (nv && nv.code === 0) {
    for (const line of nv.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [name, mib] = line.split(",").map((x) => x.trim())
      out.push({ id: "nvidia", name: `${name}${mib ? ` · ${Math.round(Number(mib) / 1024)} GB` : ""}`, flags: ["--nvidia"] })
      break
    }
  }
  // ROCm needs /dev/kfd, readable and writable by the user (the render group, or a world-writable node as on Arch).
  const kfd = join(h.dev, "kfd")
  const nodes = join(h.sys, "class", "kfd", "kfd", "topology", "nodes")
  if (existsSync(kfd) && existsSync(nodes)) {
    for (const node of readdirSync(nodes).sort()) {
      let props = ""
      try {
        props = readFileSync(join(nodes, node, "properties"), "utf8")
      } catch {
        continue
      }
      const gfx = Number(/gfx_target_version (\d+)/.exec(props)?.[1] ?? 0)
      if (!gfx) continue
      const target = `gfx${Math.floor(gfx / 10000)}${Math.floor((gfx % 10000) / 100)}${(gfx % 100).toString(16)}`
      let name = target
      try {
        // amdgpu names a node after its marketing name on some kernels and "ip discovery" on others
        const own = readFileSync(join(nodes, node, "name"), "utf8").trim()
        name = own && !/ip discovery/i.test(own) ? own : "AMD Radeon"
      } catch {
        // the node has no name file
      }
      if (APU_GFX.has(gfx)) {
        out.push({
          id: "amd-igpu",
          name: `${name} (${target}, integrated)`,
          flags: ["--amd"],
          note: "integrated Radeon: shares the system RAM; ROCm's PyTorch for it is a preview, checked after the install",
          env: { HSA_OVERRIDE_GFX_VERSION: GFX_OVERRIDE[gfx]! },
        })
      } else {
        out.push({ id: "amd", name: `${name} (${target})`, flags: ["--amd"] })
      }
    }
  }
  out.push({ id: "cpu", name: "CPU", flags: ["--cpu"], note: "slow: minutes per image" })
  return out
}

export interface Step {
  readonly cmd: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  // What the step does, printed before it.
  readonly say: string
}

// The commands that install a tool, in order. A tool already there at another version is installed over.
export function installSteps(tool: ToolName, h: Home = home(), gpu?: Gpu): Step[] {
  if (tool === "hyperframes") {
    const prefix = hyperframesPrefix(h)
    return [
      { say: `HyperFrames ${PINS.hyperframes} into ${prefix}`, cmd: "npm", args: ["install", "--prefix", prefix, "--no-audit", "--no-fund", `hyperframes@${PINS.hyperframes}`] },
      { say: `link ${join(localBin(h), "hyperframes")}`, cmd: "ln", args: ["-sfn", join(prefix, "node_modules", ".bin", "hyperframes"), join(localBin(h), "hyperframes")] },
    ]
  }
  if (tool === "manim") {
    return [{ say: `Manim ${PINS.manim} as a uv tool`, cmd: "uv", args: ["tool", "install", "--force", `manim==${PINS.manim}`] }]
  }
  if (tool === "comfy-mcp") {
    // comfy-mcp finds ComfyUI through comfy-cli's default workspace.
    return [
      { say: `comfy-mcp ${PINS.comfyMcp} as a uv tool`, cmd: "uv", args: ["tool", "install", "--force", `comfy-mcp==${PINS.comfyMcp}`] },
      { say: `comfy-cli's default workspace: ${comfyWorkspace(h)}`, cmd: "comfy", args: ["--skip-prompt", "set-default", comfyWorkspace(h)] },
    ]
  }
  const device = gpu ?? { id: "cpu", name: "CPU", flags: ["--cpu"] }
  const workspace = comfyWorkspace(h)
  // comfy-cli asks about analytics on its first run; it is answered once, with no.
  return [
    { say: `comfy-cli ${PINS.comfyCli} as a uv tool`, cmd: "uv", args: ["tool", "install", "--force", `comfy-cli==${PINS.comfyCli}`] },
    { say: "comfy-cli: no analytics", cmd: "comfy", args: ["--skip-prompt", "tracking", "disable"] },
    {
      say: `ComfyUI ${PINS.comfyui} into ${workspace}, for ${device.name}`,
      cmd: "comfy",
      args: ["--skip-prompt", "--workspace", workspace, "install", "--version", PINS.comfyui, "--skip-manager", ...device.flags],
    },
  ]
}

// ComfyUI's Python: comfy-cli installs ComfyUI's requirements into the environment it runs in (its uv tool), or into
// the workspace's own .venv when there is one.
export function comfyPython(h: Home = home(), workspace = comfyWorkspace(h)): string {
  const own = [".venv", "venv"].map((v) => join(workspace, v, "bin", "python")).find((p) => existsSync(p))
  if (own) return own
  return join(h.env.UV_TOOL_DIR || join(h.home, ".local", "share", "uv", "tools"), "comfy-cli", "bin", "python")
}

// After a ComfyUI install on a GPU: whether its PyTorch sees the GPU, first as it is and, for an integrated Radeon,
// then as the discrete family it is close to. A "no" keeps the install (the CPU still works) and says so; the
// integrated Radeons are where this is expected to fail first.
export const TORCH_PROBE = "import torch; print('gpu' if torch.cuda.is_available() else 'cpu', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"

export function torchChecks(gpu: Gpu, h: Home = home(), workspace = comfyWorkspace(h)): Step[] {
  if (gpu.id === "cpu") return []
  const step = (env?: Readonly<Record<string, string>>): Step => ({ say: `does ComfyUI's PyTorch see ${gpu.name}${env ? ` (as ${Object.values(env).join(" ")})` : ""}?`, cmd: comfyPython(h, workspace), args: ["-c", TORCH_PROBE], ...(env ? { env } : {}) })
  return gpu.env ? [step(), step(gpu.env)] : [step()]
}

// The line to start ComfyUI with after the install, with the environment the check found it needs.
export function comfyLaunch(env: Readonly<Record<string, string>> = {}, h: Home = home()): string {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v} `).join("")
  return `${vars}comfy --workspace ${comfyWorkspace(h)} launch -- --listen 127.0.0.1 --port 8188`
}

// The comfy MCP server in OpenCode's config (mcp.servers.comfy), added once and nothing else changed. A config that is
// not plain JSON (comments) is left alone: rewriting it would drop the comments, so the user is told the entry instead.
export const COMFY_MCP_ENTRY = (h: Home = home()) => ({ type: "local", command: [join(localBin(h), "comfy-mcp")] })

export function addComfyMcp(configFile: string, h: Home = home()): { changed: boolean; say: string } {
  const entry = COMFY_MCP_ENTRY(h)
  let config: Record<string, unknown> = {}
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>
    } catch {
      return { changed: false, say: `${configFile} is not plain JSON; add this under "mcp": { "servers": { … } } by hand: "comfy": ${JSON.stringify(entry)}` }
    }
  }
  const mcp = (config["mcp"] && typeof config["mcp"] === "object" ? config["mcp"] : {}) as Record<string, unknown>
  const servers = (mcp["servers"] && typeof mcp["servers"] === "object" ? mcp["servers"] : {}) as Record<string, unknown>
  if (servers["comfy"]) return { changed: false, say: `${configFile} already has an MCP server named comfy` }
  servers["comfy"] = entry
  mcp["servers"] = servers
  config["mcp"] = mcp
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
  return { changed: true, say: `added the comfy MCP server to ${configFile} (restart OpenCode to load it)` }
}
