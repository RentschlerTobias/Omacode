// A6 (slimmed): the preflight, the profiles, doctor's plugin, tool and machine checks, the uninstall plan, and the
// comfy MCP entry in OpenCode's config. Every probe is handed in, so nothing here asks the real machine.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

import { addComfyMcp, PINS, type Found } from "../packages/micromanager/src/creative-tools.ts"
import {
  failed,
  formatChecks,
  machineChecks,
  pluginChecks,
  preflight,
  PROFILES,
  profilePlan,
  toolChecks,
  uninstallPlan,
  type Paths,
  type Probe,
} from "../packages/micromanager/src/setup.ts"
import type { Exec } from "../packages/micromanager/src/worktree/git.ts"

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "setup-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A machine as a table of answers: "cmd arg…" → result; anything else fails.
const fakeRun = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): Exec =>
  async (cmd, args) => {
    const a = answers[[cmd, ...args].join(" ")]
    return { code: a ? (a.code ?? 0) : 127, stdout: a?.stdout ?? "", stderr: a?.stderr ?? "" } as Awaited<ReturnType<Exec>>
  }

const probe = (over: Partial<Probe> = {}, have: readonly string[] = ["git", "uv", "ffmpeg", "bwrap"]): Probe => ({
  platform: "linux",
  arch: "x64",
  node: "24.1.0",
  totalMem: 32 * 1024 ** 3,
  env: { HOME: "/home/u", PATH: "/nowhere" },
  run: fakeRun({ "opencode --version": { stdout: "2.2.5\n" } }),
  freeBytes: () => 100 * 1024 ** 3,
  which: (name) => (have.includes(name) ? `/usr/bin/${name}` : undefined),
  ...over,
})

const levelOf = (checks: { area: string; level: string }[], area: string) => checks.find((c) => c.area === area)?.level

test("preflight: an old Node or no OpenCode blocks the install; missing tools and macOS are warnings with a reason", async () => {
  const good = await preflight(probe())
  assert.equal(failed(good), false)
  assert.equal(levelOf(good, "node"), "ok")
  assert.equal(levelOf(good, "opencode"), "ok")

  const old = await preflight(probe({ node: "20.11.0" }))
  assert.equal(levelOf(old, "node"), "fail")
  assert.equal(failed(old), true)

  const none = await preflight(probe({ run: fakeRun({}) }))
  assert.equal(levelOf(none, "opencode"), "fail")
  const older = await preflight(probe({ run: fakeRun({ "opencode --version": { stdout: "2.1.0" } }) }))
  assert.equal(levelOf(older, "opencode"), "warn")

  const bare = await preflight(probe({}, []))
  assert.equal(levelOf(bare, "uv"), "warn")
  assert.equal(levelOf(bare, "bwrap"), "warn")
  assert.equal(levelOf(bare, "ffmpeg"), "info")
  assert.equal(failed(bare), false, "a missing optional tool does not block the plugin")
  assert.match(formatChecks(bare), /uv not found: the decider service/)

  const mac = await preflight(probe({ platform: "darwin" }))
  assert.equal(levelOf(mac, "system"), "warn")
  assert.equal(mac.some((c) => c.area === "bwrap"), false, "bubblewrap is not asked for on macOS")
  assert.equal(levelOf(await preflight(probe({ platform: "win32" })), "system"), "fail")

  const small = await preflight(probe({ totalMem: 4 * 1024 ** 3, freeBytes: () => 2 * 1024 ** 3 }))
  assert.equal(levelOf(small, "memory"), "warn")
  assert.equal(levelOf(small, "disk"), "warn")
})

test("profiles say what they download, and a profile does not install a tool that is already there", () => {
  for (const p of Object.values(PROFILES)) assert.ok(p.download.length > 0, p.title)
  assert.deepEqual(profilePlan("minimal", []), { services: false, tools: [] })
  assert.deepEqual(profilePlan("coding", []), { services: true, tools: [] })
  const found: Found[] = [{ name: "hyperframes", found: true, version: PINS.hyperframes }, { name: "comfyui", found: false }]
  assert.deepEqual(profilePlan("creator", found), { services: true, tools: ["comfyui", "comfy-mcp"] })
  assert.deepEqual(profilePlan("full", found).tools, ["comfyui", "comfy-mcp", "manim"])
})

function layout(t: TestContext): Paths {
  const root = tmp(t)
  const oc = join(root, "opencode")
  mkdirSync(join(oc, "plugins"), { recursive: true })
  return {
    opencodeDir: oc,
    pluginLink: join(oc, "plugins", "omacode.ts"),
    tuiDir: join(oc, "omacode-tui"),
    cliJson: join(oc, "cli.json"),
    opencodeJson: join(oc, "opencode.json"),
    config: join(oc, "omacode.jsonc"),
    data: join(root, "data"),
    state: join(root, "state"),
    unit: join(root, "omacode-services.service"),
  }
}

test("doctor finds the plugin by its link or its package, and says a dangling link, a missing TUI and a broken config", (t) => {
  const at = layout(t)
  assert.equal(levelOf(pluginChecks(at), "plugin"), "fail", "nothing installed")

  const target = join(at.opencodeDir, "..", "plugin.ts")
  writeFileSync(target, "")
  symlinkSync(target, at.pluginLink)
  mkdirSync(at.tuiDir)
  writeFileSync(join(at.tuiDir, "tui.tsx"), "")
  writeFileSync(at.cliJson, JSON.stringify({ plugins: [at.tuiDir] }))
  writeFileSync(at.config, "{ // a comment\n \"memory\": {} }\n")
  writeFileSync(at.opencodeJson, JSON.stringify({ plugins: ["/src/omacode/packages/full"] }))
  const good = pluginChecks(at)
  assert.equal(failed(good), false, formatChecks(good))
  assert.equal(levelOf(good, "tui"), "ok")
  assert.equal(levelOf(good, "config"), "ok")
  assert.ok(good.some((c) => c.level === "info" && /also listed in opencode\.json/.test(c.text)))

  rmSync(target)
  writeFileSync(at.config, "{ broken")
  writeFileSync(at.cliJson, "{}")
  const bad = pluginChecks(at)
  assert.match(bad.find((c) => c.area === "plugin" && c.level === "fail")?.text ?? "", /which is gone/)
  assert.equal(levelOf(bad, "tui"), "warn")
  assert.equal(levelOf(bad, "config"), "fail")
})

test("doctor's tool checks: a version off the pin is a warning, and comfy-mcp that OpenCode does not start is named", (t) => {
  const at = layout(t)
  const checks = toolChecks([
    { name: "hyperframes", found: true, version: "0.9.88" },
    { name: "manim", found: false },
    { name: "comfy-mcp", found: true, version: PINS.comfyMcp },
  ], at.opencodeJson)
  assert.equal(levelOf(checks, "hyperframes"), "warn")
  assert.equal(levelOf(checks, "manim"), "info")
  assert.ok(checks.some((c) => c.area === "comfy-mcp" && c.level === "warn" && /OpenCode does not start it/.test(c.text)))
  addComfyMcp(at.opencodeJson)
  assert.equal(toolChecks([{ name: "comfy-mcp", found: true, version: PINS.comfyMcp }], at.opencodeJson).every((c) => c.level === "ok"), true)
})

test("doctor's machine checks: the services unit, the sandbox, and only the HyperFrames checks a deck needs", async (t) => {
  const at = layout(t)
  const doctorOut = "  ✗ Version          0.9.54 → 0.9.88 available\n  ✗ whisper-cpp      Not found (optional)\n  ✗ Docker running   Not running\n  ✓ FFmpeg  ok\n"
  const run = fakeRun({ "bwrap --ro-bind / / --dev /dev true": {}, "hyperframes doctor": { code: 1, stdout: doctorOut } })
  const p = probe({ run }, ["hyperframes"])
  let checks = await machineChecks(p, at)
  assert.equal(levelOf(checks, "services"), "info", "no unit: not installed, not a failure")
  assert.equal(levelOf(checks, "sandbox"), "ok")
  assert.equal(levelOf(checks, "hyperframes"), "ok", "optional extras, Docker and a newer release do not count")

  writeFileSync(at.unit, "")
  const broken = fakeRun({ "systemctl --user is-active omacode-services.service": { code: 3, stdout: "failed\n" }, "hyperframes doctor": { code: 1, stdout: "  ✗ Chrome   not found\n" } })
  checks = await machineChecks(probe({ run: broken }, ["hyperframes"]), at)
  assert.equal(levelOf(checks, "services"), "warn")
  assert.equal(levelOf(checks, "sandbox"), "fail")
  assert.match(checks.find((c) => c.area === "hyperframes")?.text ?? "", /Chrome/)
})

test("uninstall removes what the install made and keeps the user's data; --purge also takes tools and services", (t) => {
  const at = layout(t)
  writeFileSync(at.pluginLink, "")
  mkdirSync(at.tuiDir)
  writeFileSync(at.unit, "")
  mkdirSync(join(at.data, "tools"), { recursive: true })
  mkdirSync(join(at.data, "services"), { recursive: true })
  mkdirSync(at.state, { recursive: true })
  writeFileSync(at.config, "{}")
  const plain = uninstallPlan(at)
  assert.deepEqual(plain.remove.map((r) => r.path), [at.pluginLink, at.tuiDir, at.unit])
  assert.ok(plain.keep.some((k) => k.path === join(at.data, "tools")))
  assert.ok(plain.keep.some((k) => k.path === at.state && /never removed/.test(k.what)))
  assert.ok(plain.keep.some((k) => k.path === at.config))
  const purge = uninstallPlan(at, { purge: true })
  assert.ok(purge.remove.some((r) => r.path === join(at.data, "tools")))
  assert.ok(purge.remove.some((r) => r.path === join(at.data, "services")))
  assert.ok(purge.keep.some((k) => k.path === at.state), "the state stays even with --purge")
})

test("the comfy MCP server is added to opencode.json once, beside what is there; a commented config is left alone", (t) => {
  const dir = tmp(t)
  const h = { home: "/home/u", data: join(dir, "data"), env: {}, sys: "/sys", dev: "/dev" }
  const fresh = join(dir, "fresh.json")
  assert.equal(addComfyMcp(fresh, h).changed, true)
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { mcp: { servers: { comfy: { type: "local", command: ["/home/u/.local/bin/comfy-mcp"] } } } })

  const other = join(dir, "other.json")
  writeFileSync(other, JSON.stringify({ model: "x", mcp: { servers: { cad: { type: "local", command: ["cad"] } } } }))
  addComfyMcp(other, h)
  const merged = JSON.parse(readFileSync(other, "utf8"))
  assert.equal(merged.model, "x")
  assert.deepEqual(Object.keys(merged.mcp.servers), ["cad", "comfy"])
  assert.equal(addComfyMcp(other, h).changed, false, "a second run changes nothing")

  const commented = join(dir, "commented.json")
  writeFileSync(commented, "{ // mine\n}\n")
  const r = addComfyMcp(commented, h)
  assert.equal(r.changed, false)
  assert.match(r.say, /not plain JSON/)
  assert.equal(readFileSync(commented, "utf8"), "{ // mine\n}\n")
})
