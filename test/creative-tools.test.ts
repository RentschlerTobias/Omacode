// A6-T6/T7: the optional creative tools install.sh asks about. A fake exec and a fake /sys and /dev stand in; nothing
// is installed.

import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { comfyLaunch, comfyPython, detect, gpus, installSteps, PINS, torchChecks, type Home } from "../packages/micromanager/src/creative-tools.ts"
import type { Exec } from "../packages/micromanager/src/worktree/git.ts"

const ROOT = tempDir("mm-tools-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const fakeRun = (answers: Record<string, { code?: number; stdout?: string }>): Exec => async (cmd, args) => {
  const a = answers[[cmd, ...args].join(" ")] ?? answers[cmd]
  return { code: a ? (a.code ?? 0) : 127, stdout: a?.stdout ?? "", stderr: "", timedOut: false }
}

let n = 0
function machine(): Home {
  const home = join(ROOT, `m${++n}`)
  mkdirSync(home, { recursive: true })
  return { home, data: join(home, ".local", "share", "omacode"), env: { HOME: home }, sys: join(home, "sys"), dev: join(home, "dev") }
}

function kfdNode(h: Home, node: string, gfx: number, name = "") {
  const dir = join(h.sys, "class", "kfd", "kfd", "topology", "nodes", node)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "properties"), `cpu_cores_count 0\ngfx_target_version ${gfx}\n`)
  writeFileSync(join(dir, "name"), name)
  mkdirSync(h.dev, { recursive: true })
  writeFileSync(join(h.dev, "kfd"), "")
}

test("found or not: the version each tool prints, ComfyUI from its workspace", async () => {
  const h = machine()
  const none = await detect(fakeRun({}), h)
  assert.deepEqual(none.map((t) => [t.name, t.found]), [["hyperframes", false], ["manim", false], ["comfyui", false], ["comfy-mcp", false]])
  mkdirSync(join(h.home, "Apps", "ComfyUI"), { recursive: true })
  writeFileSync(join(h.home, "Apps", "ComfyUI", "comfyui_version.py"), '__version__ = "0.38.0"\n')
  // comfy-mcp starts a server when run, so it is read from uv's tool list
  const some = await detect(fakeRun({ "hyperframes --version": { stdout: "hyperframes v0.9.54\n" }, "manim --version": { stdout: "Manim Community v0.22.1\n" }, "uv tool list": { stdout: "comfy-cli v1.25.0\n- comfy\ncomfy-mcp v0.10.0\n- comfy-mcp\n" } }), h)
  assert.deepEqual(some.map((t) => t.version), ["0.9.54", "0.22.1", "0.38.0", "0.10.0"])
  assert.equal(some[2]!.where, join(h.home, "Apps", "ComfyUI"), "one installed by hand is found")
  const ours = join(h.data, "tools", "comfyui")
  mkdirSync(ours, { recursive: true })
  writeFileSync(join(ours, "comfyui_version.py"), '__version__ = "0.44.2"\n')
  assert.equal((await detect(fakeRun({}), h))[2]!.where, ours, "the tools directory first")
})

test("where ComfyUI could run: the NVIDIA GPU, an integrated Radeon ROCm can reach, always the CPU", async () => {
  const h = machine()
  assert.deepEqual((await gpus(fakeRun({}), h)).map((g) => g.id), ["cpu"], "nothing found: the CPU only")
  kfdNode(h, "0", 0)
  kfdNode(h, "1", 110500, "ip discovery")
  const found = await gpus(fakeRun({ "nvidia-smi": { stdout: "NVIDIA GeForce RTX 4060 Laptop GPU, 8188\n" } }), h)
  assert.deepEqual(found.map((g) => g.id), ["nvidia", "amd-igpu", "cpu"])
  assert.equal(found[0]!.name, "NVIDIA GeForce RTX 4060 Laptop GPU · 8 GB")
  assert.equal(found[1]!.name, "AMD Radeon (gfx1150, integrated)")
  assert.deepEqual(found[1]!.flags, ["--amd"])
  assert.equal(found[1]!.env?.HSA_OVERRIDE_GFX_VERSION, "11.0.0")
  assert.match(found[1]!.note ?? "", /preview/)

  const discrete = machine()
  kfdNode(discrete, "1", 110000, "Radeon RX 7900 XTX")
  assert.deepEqual((await gpus(fakeRun({}), discrete)).map((g) => [g.id, g.name]), [["amd", "Radeon RX 7900 XTX (gfx1100)"], ["cpu", "CPU"]])

  const noKfd = machine()
  kfdNode(noKfd, "1", 110500)
  rmSync(join(noKfd.dev, "kfd"))
  assert.deepEqual((await gpus(fakeRun({}), noKfd)).map((g) => g.id), ["cpu"], "no /dev/kfd: ROCm cannot reach it")
})

test("each install is pinned and stays in the home", async () => {
  const h = machine()
  const hf = installSteps("hyperframes", h)
  assert.deepEqual(hf[0]!.args.slice(0, 3), ["install", "--prefix", join(h.data, "tools", "hyperframes")])
  assert.ok(hf[0]!.args.includes(`hyperframes@${PINS.hyperframes}`))
  assert.deepEqual(hf[1]!.args, ["-sfn", join(h.data, "tools", "hyperframes", "node_modules", ".bin", "hyperframes"), join(h.home, ".local", "bin", "hyperframes")])
  assert.deepEqual(installSteps("manim", h).map((s) => [s.cmd, ...s.args].join(" ")), [`uv tool install --force manim==${PINS.manim}`])

  kfdNode(h, "1", 110500)
  const [, igpu] = await gpus(fakeRun({ "nvidia-smi": { stdout: "X, 1024\n" } }), h)
  const comfy = installSteps("comfyui", h, igpu).map((s) => [s.cmd, ...s.args].join(" "))
  assert.deepEqual(comfy, [
    `uv tool install --force comfy-cli==${PINS.comfyCli}`,
    "comfy --skip-prompt tracking disable",
    `comfy --skip-prompt --workspace ${join(h.data, "tools", "comfyui")} install --version ${PINS.comfyui} --skip-manager --amd`,
  ])
  assert.match(installSteps("comfyui", h).at(-1)!.args.join(" "), /--cpu$/, "no device named: the CPU")
})

test("after a GPU install PyTorch is asked whether it sees the GPU, an integrated Radeon also as its family", async () => {
  const h = machine()
  kfdNode(h, "1", 110500)
  const [igpu, cpu] = await gpus(fakeRun({}), h)
  const checks = torchChecks(igpu!, h)
  assert.equal(checks.length, 2)
  assert.equal(checks[0]!.cmd, join(h.home, ".local", "share", "uv", "tools", "comfy-cli", "bin", "python"))
  assert.equal(checks[0]!.env, undefined)
  assert.deepEqual(checks[1]!.env, { HSA_OVERRIDE_GFX_VERSION: "11.0.0" })
  assert.deepEqual(torchChecks(cpu!, h), [])
  const ws = join(h.data, "tools", "comfyui")
  mkdirSync(join(ws, ".venv", "bin"), { recursive: true })
  writeFileSync(join(ws, ".venv", "bin", "python"), "")
  assert.equal(comfyPython(h), join(ws, ".venv", "bin", "python"), "a workspace venv wins")
  mkdirSync(join(h.home, "Apps", "ComfyUI", "venv", "bin"), { recursive: true })
  writeFileSync(join(h.home, "Apps", "ComfyUI", "venv", "bin", "python"), "")
  assert.equal(comfyPython(h, join(h.home, "Apps", "ComfyUI")), join(h.home, "Apps", "ComfyUI", "venv", "bin", "python"), "venv/ as well")
  assert.equal(comfyLaunch({ HSA_OVERRIDE_GFX_VERSION: "11.0.0" }, h), `HSA_OVERRIDE_GFX_VERSION=11.0.0 comfy --workspace ${ws} launch -- --listen 127.0.0.1 --port 8188`)
})

test("comfy-mcp is a pinned uv tool, pointed at the ComfyUI workspace through comfy-cli's default", () => {
  const h = machine()
  const steps = installSteps("comfy-mcp", h).map((s) => [s.cmd, ...s.args].join(" "))
  assert.deepEqual(steps, [
    `uv tool install --force comfy-mcp==${PINS.comfyMcp}`,
    `comfy --skip-prompt set-default ${join(h.data, "tools", "comfyui")}`,
  ])
})
