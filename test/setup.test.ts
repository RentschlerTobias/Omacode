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
  OFFER_IDS,
  OFFERS,
  packageManager,
  planFor,
  PROFILES,
  requiredNeeds,
  systemInstall,
  UV_PIN,
  toolChecks,
  uninstallPlan,
  type Paths,
  type Present,
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
  // OpenCode 1 (what opencode.ai/install gives) cannot load a v2 plugin: that blocks, with the v2 installer as the fix.
  const v1 = await preflight(probe({ run: fakeRun({ "opencode --version": { stdout: "1.19.6" } }) }))
  assert.equal(levelOf(v1, "opencode"), "fail")
  assert.match(v1.find((c) => c.area === "opencode")?.fix ?? "", /opencode\.ai\/v2\/install/)

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

test("the package manager is found, and each need becomes one install command or a line for the user", () => {
  const has = (...names: string[]) => ({ platform: "linux" as const, which: (n: string) => (names.includes(n) ? `/usr/bin/${n}` : undefined) })
  assert.equal(packageManager(has("pacman")), "pacman")
  assert.equal(packageManager(has("apt-get")), "apt")
  assert.equal(packageManager(has("dnf")), "dnf")
  assert.equal(packageManager(has()), undefined)
  assert.equal(packageManager({ platform: "darwin", which: (n) => (n === "brew" ? "/opt/homebrew/bin/brew" : undefined) }), "brew")

  const arch = systemInstall("pacman", ["git", "bubblewrap", "uv"], false, false)
  assert.deepEqual(arch.commands.map((c) => [c.cmd, ...c.args].join(" ")), ["sudo pacman -S --needed --noconfirm git bubblewrap uv"])
  // root in a fresh container: no sudo (there is none), and -Syu because the package database was never synced
  const container = systemInstall("pacman", ["git"], true, true)
  assert.deepEqual(container.commands.map((c) => [c.cmd, ...c.args].join(" ")), ["pacman -Syu --needed --noconfirm git"])
  assert.deepEqual(arch.manual, [])

  // apt has no uv and an old Node: uv comes from its own pinned installer, Node is the user's to install.
  const debian = systemInstall("apt", ["chromium", "uv", "node"], false)
  assert.deepEqual(debian.commands.map((c) => c.cmd), ["sudo", "sh"])
  assert.deepEqual(debian.commands[0]!.args, ["apt-get", "install", "-y", "chromium"])
  assert.match(debian.commands[1]!.args.join(" "), new RegExp(`astral\\.sh/uv/${UV_PIN.replace(/\./g, "\\.")}/install\\.sh`))
  assert.match(debian.manual.join(), /Node 22\.18/)

  const mac = systemInstall("brew", ["git", "ffmpeg"], false)
  assert.deepEqual(mac.commands.map((c) => [c.cmd, ...c.args].join(" ")), ["brew install git ffmpeg"], "brew needs no sudo")
  assert.match(systemInstall(undefined, ["git"]).manual.join(), /git: install it/)
})

test("required: git everywhere, bubblewrap on Linux, and nothing once they are there", () => {
  const none = (platform: NodeJS.Platform) => ({ platform, which: () => undefined })
  assert.deepEqual(requiredNeeds(none("linux")), ["git", "bubblewrap"])
  assert.deepEqual(requiredNeeds(none("darwin")), ["git"])
  assert.deepEqual(requiredNeeds({ platform: "linux", which: (n) => `/usr/bin/${n}` }), [])
})

const present = (over: Partial<Present> = {}): Present => ({ services: false, chromium: false, tools: [], which: () => undefined, ...over })

test("the answers become a plan: parts already there are dropped, comfy-mcp needs ComfyUI, uv comes along when needed", () => {
  assert.deepEqual(planFor([], present()), { system: [], services: false, tools: [] })
  assert.deepEqual(planFor(["chromium", "hyperframes"], present()), { system: ["chromium"], services: false, tools: ["hyperframes"] }, "HyperFrames needs npm, not uv")
  assert.deepEqual(planFor(["services"], present()), { system: ["uv"], services: true, tools: [] })
  assert.deepEqual(planFor(["services"], present({ which: (n) => (n === "uv" ? "/usr/bin/uv" : undefined) })).system, [], "uv already there")
  assert.deepEqual(planFor(["comfy-mcp"], present()).tools, [], "comfy-mcp without ComfyUI is dropped")
  assert.deepEqual(planFor(["comfyui", "comfy-mcp"], present()).tools, ["comfyui", "comfy-mcp"])
  const withComfy = present({ tools: [{ name: "comfyui", found: true, version: "0.44.2" }], services: true, chromium: true })
  assert.deepEqual(planFor(["services", "chromium", "comfyui", "comfy-mcp"], withComfy), { system: ["uv"], services: false, tools: ["comfy-mcp"] })
})

test("every offer says what it is for and what it downloads, and every profile is a set of offers", () => {
  for (const id of OFFER_IDS) {
    assert.ok(OFFERS[id].what.length > 10 && OFFERS[id].size.length > 0, id)
  }
  assert.deepEqual(PROFILES.minimal.offers, [])
  assert.deepEqual(PROFILES.coding.offers, ["services"])
  assert.ok(PROFILES.full.offers.includes("manim") && !PROFILES.creator.offers.includes("manim"))
  for (const p of Object.values(PROFILES)) for (const o of p.offers) assert.ok((OFFER_IDS as readonly string[]).includes(o))
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

  // Installed from npm alone (opencode plugin add): the package entry is the install.
  rmSync(at.pluginLink)
  assert.ok(pluginChecks(at).some((c) => c.area === "plugin" && c.level === "ok" && /installed as a package/.test(c.text)))
  // @omacode/full brings the TUI: no cli.json entry is needed.
  writeFileSync(at.cliJson, "{}")
  assert.match(pluginChecks(at).find((c) => c.area === "tui")?.text ?? "", /the TUI comes with \/src\/omacode\/packages\/full/)
  writeFileSync(at.cliJson, JSON.stringify({ plugins: [at.tuiDir] }))
  symlinkSync(target, at.pluginLink)

  rmSync(target)
  writeFileSync(at.config, "{ broken")
  writeFileSync(at.cliJson, "{}")
  const bad = pluginChecks(at)
  assert.match(bad.find((c) => c.area === "plugin" && c.level === "fail")?.text ?? "", /which is gone/)
  assert.equal(levelOf(bad, "tui"), "ok", "@omacode/full is listed, and it brings the TUI")
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
  const p = probe({ run }, ["hyperframes", "bwrap"])
  let checks = await machineChecks(p, at)
  assert.equal(levelOf(checks, "services"), "info", "no unit: not installed, not a failure")
  assert.equal(levelOf(checks, "sandbox"), "ok")
  assert.equal(levelOf(checks, "hyperframes"), "ok", "optional extras, Docker and a newer release do not count")

  writeFileSync(at.unit, "")
  const broken = fakeRun({ "systemctl --user is-active omacode-services.service": { code: 3, stdout: "failed\n" }, "hyperframes doctor": { code: 1, stdout: "  ✗ Chrome   not found\n" } })
  checks = await machineChecks(probe({ run: broken }, ["hyperframes", "bwrap"]), at)
  assert.equal(levelOf(checks, "services"), "warn")
  assert.equal(levelOf(checks, "sandbox"), "fail")
  assert.match(checks.find((c) => c.area === "hyperframes")?.text ?? "", /Chrome/)

  // Not installed at all (an npm install without install.sh): said so, with the command that installs it.
  checks = await machineChecks(probe({ run: broken }, []), at)
  assert.match(checks.find((c) => c.area === "sandbox")?.text ?? "", /bubblewrap is not installed/)
  assert.match(checks.find((c) => c.area === "sandbox")?.fix ?? "", /omacode setup required/)
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
