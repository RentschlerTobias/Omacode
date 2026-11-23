// The /services menu and `services mode`: what they show from the supervisor's status file and what they write to its
// control file. The supervisor applying that file is test/supervisor.test.ts's.

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { readControl } from "../packages/core/src/supervisor.ts"
import { deviceName, serviceLine, servicesView, setIdleMinutes, setServiceDevice, setServiceMode } from "../packages/core/src/service-control.ts"
import { deviceArgs, parseDevices } from "../packages/micromanager/src/services-main.ts"

const ROOT = tempDir("mm-service-control-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

test("no status file: not running, nothing to switch", () => {
  const view = servicesView({ OMACODE_RUN_DIR: join(ROOT, "none") })
  assert.equal(view.running, false)
  assert.deepEqual(view.services, [])
})

test("a switch is merged into the control file the supervisor reads, and shows before the supervisor applied it", () => {
  const dir = join(ROOT, "run")
  mkdirSync(dir)
  const env = { OMACODE_RUN_DIR: dir }
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    updated: "2026-11-22T14:00:00.000Z",
    idleMinutes: 10,
    services: {
      decider: { mode: "auto", state: "running", url: "http://127.0.0.1:8781" },
      embedding: { mode: "auto", state: "stopped", url: "http://127.0.0.1:8093", detail: "stopped after 10 min without a request" },
    },
  }))
  const before = servicesView(env)
  assert.equal(before.running, true)
  assert.equal(before.idleMinutes, 10)
  assert.deepEqual(before.services.map(serviceLine), ["auto · running", "auto · stopped · stopped after 10 min without a request"])

  setServiceMode("embedding", "off", env)
  setServiceMode("decider", "on", env)
  setIdleMinutes(30, env)
  const control = JSON.parse(readFileSync(join(dir, "control.json"), "utf8"))
  assert.deepEqual(control, { embedding: "off", decider: "on", idleMinutes: 30 }, "each write keeps the others")
  assert.equal(statSync(join(dir, "control.json")).mode & 0o777, 0o600)
  assert.deepEqual(readControl(join(dir, "control.json"), ["decider", "embedding"], {}), { modes: { decider: "on", embedding: "off" }, idleMs: 30 * 60_000, devices: {} })

  const now = servicesView(env)
  assert.deepEqual(now.services.map((s) => s.mode), ["on", "off"], "the asked mode, not the last reported one")
  assert.equal(serviceLine(now.services[1]!), "off")
  assert.equal(now.idleMinutes, 30)
})

test("a device pick is kept beside the modes and shows in the menu line", () => {
  const dir = join(ROOT, "devices")
  mkdirSync(dir)
  const env = { OMACODE_RUN_DIR: dir }
  const devices = [{ id: "cpu", name: "CPU" }, { id: "Vulkan0", name: "NVIDIA GeForce RTX 4060 Laptop GPU · 8 GB" }, { id: "Vulkan1", name: "AMD Radeon 890M Graphics (RADV STRIX1) · 16 GB" }]
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    services: {
      decider: { mode: "auto", state: "running", device: "cpu", devices: [devices[0]] },
      embedding: { mode: "auto", state: "running", device: "cpu", devices },
    },
  }))
  setServiceMode("embedding", "on", env)
  setServiceDevice("embedding", "Vulkan1", env)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "control.json"), "utf8")), { embedding: "on", devices: { embedding: "Vulkan1" } })
  const [decider, embedding] = servicesView(env).services
  assert.equal(serviceLine(decider!), "auto · running · on CPU", "one device: shown, nothing to pick")
  assert.equal(serviceLine(embedding!), "on · running · on Vulkan1")
  assert.equal(deviceName(embedding!), "AMD Radeon 890M Graphics (RADV STRIX1) · 16 GB")
})

test("llama.cpp's device list, with the CPU first, and the arguments for each choice", () => {
  const listed = parseDevices(`load_backend: loaded Vulkan backend
Available devices:
  Vulkan0: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 6990 MiB free)
  Vulkan1: AMD Radeon 890M Graphics (RADV STRIX1) (16103 MiB, 15701 MiB free)
`)
  assert.deepEqual(listed, [
    { id: "cpu", name: "CPU" },
    { id: "Vulkan0", name: "NVIDIA GeForce RTX 4060 Laptop GPU · 8 GB" },
    { id: "Vulkan1", name: "AMD Radeon 890M Graphics (RADV STRIX1) · 16 GB" },
  ])
  assert.deepEqual(parseDevices("error: unknown argument"), [{ id: "cpu", name: "CPU" }], "an old llama.cpp: the CPU only")
  assert.deepEqual(deviceArgs("cpu"), ["-dev", "none", "-ngl", "0"])
  assert.deepEqual(deviceArgs("Vulkan1"), ["-dev", "Vulkan1", "-ngl", "999"])
})

test("a control file the status names, on disk, is the one written and read", () => {
  const dir = join(ROOT, "named")
  const disk = join(ROOT, "disk", "control.json")
  mkdirSync(dir)
  const env = { OMACODE_RUN_DIR: dir }
  writeFileSync(join(dir, "status.json"), JSON.stringify({ control: disk, services: { embedding: { mode: "auto", state: "stopped" } } }))
  setServiceMode("embedding", "off", env)
  assert.deepEqual(JSON.parse(readFileSync(disk, "utf8")), { embedding: "off" })
  assert.equal(servicesView(env).services[0]!.mode, "off")
  assert.throws(() => readFileSync(join(dir, "control.json")), "nothing in the run directory")
})

test("bad values are refused", () => {
  const env = { OMACODE_RUN_DIR: join(ROOT, "bad") }
  assert.throws(() => setServiceMode("decider", "sometimes" as never, env))
  assert.throws(() => setIdleMinutes(0, env))
})
