// Installing omacode's optional parts, for every door: install.sh (through the CLI), the `install_feature` tool an agent
// calls, and the TUI's /setup dialog and welcome. One planner (setup.ts planFor) decides what a request needs; this
// module runs it, asynchronously and with every line of output handed to a log, so a ComfyUI install that takes
// minutes neither blocks OpenCode's server nor hides what it does.
//
// Parts in user space (the services, HyperFrames, ComfyUI, comfy-mcp, Manim, and uv from its own installer) are
// installed by any door. System packages (Chromium, ffmpeg, git, bubblewrap) need sudo, which only a terminal can
// answer: without `allowSudo` they are not run, and the result names the command for the user's terminal instead.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { findChromium } from "@omacode/artifact/chromium"
import { userConfigPath } from "@omacode/core/paths"
import { TELEMETRY_OFF } from "@omacode/core/telemetry"

import {
  addComfyMcp,
  comfyLaunch,
  comfyPython,
  comfyWorkspace,
  detect,
  gpus,
  home,
  installSteps,
  TOOL_INFO,
  torchChecks,
  type Gpu,
  type Step,
  type ToolName,
} from "./creative-tools.ts"
import { install as installServices, registerComfy, unitPath } from "./services.ts"
import { isPresent, OFFERS, packageManager, planFor, realProbe, systemInstall, type Command, type OfferId, type Present } from "./setup.ts"
import { exec, type Exec } from "./worktree/git.ts"

// The command runner the CLI and the plugin use, and the device list, for callers outside this package (the TUI).
export { exec, gpus }

export type Log = (line: string) => void

export interface StepResult {
  readonly ok: boolean
  readonly stdout: string
}

// One command, its output handed to the log line by line as it comes. Never throws.
export function runStep(cmd: string, args: readonly string[], o: { cwd?: string; env?: Readonly<Record<string, string>>; log: Log; quiet?: boolean }): Promise<StepResult> {
  return new Promise((done) => {
    let out = ""
    let child
    try {
      child = spawn(cmd, [...args], { cwd: o.cwd, env: { ...process.env, ...o.env, ...TELEMETRY_OFF }, stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      o.log(`${cmd}: ${err instanceof Error ? err.message : String(err)}`)
      return done({ ok: false, stdout: "" })
    }
    let pending = ""
    const take = (chunk: Buffer, keep: boolean) => {
      const text = chunk.toString()
      if (keep) out += text
      if (o.quiet) return
      pending += text.replace(/\r/g, "\n")
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) o.log(`  ${line}`)
    }
    child.stdout.on("data", (c: Buffer) => take(c, true))
    child.stderr.on("data", (c: Buffer) => take(c, false))
    child.on("error", (err) => {
      o.log(`${cmd}: ${err.message}`)
      done({ ok: false, stdout: out })
    })
    child.on("close", (code) => {
      if (pending.trim() && !o.quiet) o.log(`  ${pending}`)
      done({ ok: code === 0, stdout: out })
    })
  })
}

// What is on the machine now, for the planner.
export async function presentState(run: Exec): Promise<Present> {
  const probe = realProbe(run)
  return { services: existsSync(unitPath()), which: probe.which, chromium: Boolean(findChromium()), tools: await detect(run) }
}

// A creative tool's own steps, then what it needs afterwards: comfy-mcp its OpenCode entry, ComfyUI its device check
// and its place in omacode-services.
export async function installTool(name: ToolName, log: Log, gpu?: Gpu): Promise<boolean> {
  for (const s of installSteps(name, undefined, name === "comfyui" ? gpu : undefined)) {
    log(`→ ${s.say}`)
    const r = await runStep(s.cmd, s.args, { ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.env ? { env: s.env } : {}), log })
    if (!r.ok) {
      log(`${TOOL_INFO[name].title}: "${s.say}" failed`)
      return false
    }
  }
  if (name === "comfy-mcp") {
    log(`comfy-mcp installed. ${addComfyMcp(userConfigPath("opencode.json")).say}`)
    return true
  }
  if (name === "web-guidance") {
    log(`${TOOL_INFO[name].title} installed; agents get it as the skill modern-web-guidance after OpenCode restarts`)
    return true
  }
  if (name !== "comfyui") {
    log(`${TOOL_INFO[name].title} installed`)
    return true
  }
  return registerComfyTool(log, gpu)
}

// After a ComfyUI install, or for one already there: check that its PyTorch sees the GPU, and add it to
// omacode-services on that GPU (or the CPU, when it does not).
export async function registerComfyTool(log: Log, gpu?: Gpu, workspace = comfyWorkspace(home())): Promise<boolean> {
  let env: Readonly<Record<string, string>> = {}
  let seenGpu = false
  const checks: Step[] = gpu ? torchChecks(gpu, home(), workspace) : []
  for (const [i, c] of checks.entries()) {
    log(`→ ${c.say}`)
    const r = await runStep(c.cmd, c.args, { ...(c.cwd ? { cwd: c.cwd } : {}), ...(c.env ? { env: c.env } : {}), log, quiet: true })
    const seen = r.ok && r.stdout.startsWith("gpu")
    log(`  ${seen ? `yes: ${r.stdout.slice(4).trim()}` : "no"}`)
    if (seen) {
      env = c.env ?? {}
      seenGpu = true
      break
    }
    if (i === checks.length - 1) log(`  ComfyUI is installed but will run on the CPU: its PyTorch does not see ${gpu!.name}`)
  }
  const comfy = { python: comfyPython(home(), workspace), workspace, ...(gpu && gpu.id !== "cpu" && seenGpu ? { gpu: { id: gpu.id, name: gpu.name, ...(Object.keys(env).length ? { env } : {}) } } : {}) }
  if (registerComfy(comfy)) {
    const restarted = await runStep("systemctl", ["--user", "try-restart", "omacode-services.service"], { log, quiet: true })
    log(`ComfyUI installed and added to omacode-services on :8188, started by its first request${restarted.ok ? "" : " (restart omacode-services to load it)"}; /services switches it`)
  } else {
    log(`ComfyUI installed; start it with:\n  ${comfyLaunch(env)}\n(or install the local services and run this again to have it started on demand)`)
  }
  return true
}

export interface InstallOutcome {
  readonly ok: boolean
  // what was installed, by its title
  readonly installed: readonly string[]
  // parts that were already there
  readonly present: readonly string[]
  // system packages left for the user's terminal (no sudo here), as the command to run
  readonly terminal?: string
  readonly failed: readonly string[]
}

export interface InstallOptions {
  readonly run: Exec
  readonly log: Log
  readonly gpu?: Gpu | string
  // run sudo for system packages (install.sh in a terminal); without it they are only named
  readonly allowSudo?: boolean
  readonly there?: Present
}

// Install the parts asked for, in the planner's order: system packages, the services, the creative tools.
export async function installParts(parts: readonly OfferId[], o: InstallOptions): Promise<InstallOutcome> {
  const there = o.there ?? (await presentState(o.run))
  const plan = planFor(parts, there)
  const present = parts.filter((id) => isPresent(id, there)).map((id) => OFFERS[id].title)
  const installed: string[] = []
  const failed: string[] = []
  let terminal: string | undefined

  // uv from its own installer when sudo cannot run: it needs none, and the services and Python tools need it.
  const sudoNeeds = plan.system.filter((n) => !(n === "uv" && !o.allowSudo))
  const userNeeds = plan.system.filter((n) => n === "uv" && !o.allowSudo)
  const manager = packageManager(realProbe(o.run))
  if (sudoNeeds.length) {
    const sys = systemInstall(manager, sudoNeeds)
    if (o.allowSudo) {
      for (const m of sys.manual) {
        o.log(`install by hand: ${m}`)
        failed.push(m)
      }
      for (const c of sys.commands) (await runCommand(c, o.log)) ? installed.push(c.say) : failed.push(c.say)
    } else {
      terminal = [...sys.commands.map((c) => [c.cmd, ...c.args].join(" ")), ...sys.manual].join("; ")
      o.log(`needs your terminal (sudo): ${terminal}`)
    }
  }
  if (userNeeds.length) {
    for (const c of systemInstall(undefined, userNeeds).commands) (await runCommand(c, o.log)) ? installed.push("uv") : failed.push("uv")
    process.env.PATH = `${join(process.env.HOME ?? "", ".local", "bin")}:${process.env.PATH ?? ""}`
  }
  if (plan.services) {
    o.log("→ the local services (omacode-services: the decider and the embedding service)")
    const r = await installServices(o.run, { log: (line) => o.log(`  ${line}`) })
    if (r.ok) installed.push(OFFERS.services.title)
    else {
      o.log(`  ${r.text}`)
      failed.push(OFFERS.services.title)
    }
  }
  let gpu: Gpu | undefined
  if (plan.tools.includes("comfyui")) {
    const devices = await gpus(o.run)
    gpu = typeof o.gpu === "string" ? devices.find((g) => g.id === o.gpu) : (o.gpu ?? devices[0])
  }
  for (const name of plan.tools) {
    const need = Object.values(OFFERS).find((x) => x.tool === name)?.buildNeeds
    if (need && terminal && sudoNeeds.includes(need)) {
      o.log(`${TOOL_INFO[name].title} waits for its system libraries (the terminal command above); install them, then this part again`)
      failed.push(`${TOOL_INFO[name].title} (needs its system libraries first)`)
      continue
    }
    ;(await installTool(name, o.log, name === "comfyui" ? gpu : undefined)) ? installed.push(TOOL_INFO[name].title) : failed.push(TOOL_INFO[name].title)
  }
  return { ok: failed.length === 0, installed, present, ...(terminal ? { terminal } : {}), failed }
}

async function runCommand(c: Command, log: Log): Promise<boolean> {
  log(`→ ${c.say}`)
  return (await runStep(c.cmd, c.args, { log })).ok
}

// One sentence for a person or an agent: what happened, what is left for the terminal.
export function outcomeText(o: InstallOutcome): string {
  const parts = [
    o.installed.length ? `Installed: ${o.installed.join(", ")}.` : "",
    o.present.length ? `Already there: ${o.present.join(", ")}.` : "",
    o.failed.length ? `Failed: ${o.failed.join(", ")}.` : "",
    o.terminal ? `Needs sudo, so the user runs this in a terminal: ${o.terminal}` : "",
  ].filter(Boolean)
  return parts.join(" ") || "Nothing to install."
}
