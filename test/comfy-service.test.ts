// ComfyUI under omacode-services: started by its first request only, reachable without the token (its page and the
// image client talk to it directly), its WebSocket passed through, its device picked like the embedding service's,
// and the image client waiting while it starts. A fake backend stands in for ComfyUI.

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { connect } from "node:net"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { ComfyClient } from "../packages/artifact/src/comfyui.ts"
import { Supervisor, type ServiceSpec } from "../packages/core/src/supervisor.ts"
import { comfyService, hostServices } from "../packages/micromanager/src/services-main.ts"
import { configPath, registerComfy, type ServicesConfig } from "../packages/micromanager/src/services.ts"

const ROOT = tempDir("mm-comfy-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

// Answers /system_stats and /object_info, and upgrades /ws to a socket that echoes one line.
const FAKE = `
const http = require("node:http")
const port = Number(process.argv[1])
const s = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(req.url === "/system_stats" ? { system: {} } : { KSampler: {} }))
})
s.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n")
  socket.on("data", (d) => socket.write("echo:" + d))
})
s.listen(port, "127.0.0.1")
`
const fake = (o: Partial<ServiceSpec> = {}): ServiceSpec => ({ name: "comfyui", lazy: true, open: true, health: "/system_stats", command: (port) => ({ cmd: process.execPath, args: ["-e", FAKE, String(port)] }), startTimeoutMs: 10_000, ...o })

const until = async (what: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((done) => setTimeout(done, 25))
  }
}

test("lazy and open: not started with the supervisor, no token asked, started by the first request the client waits out", async () => {
  const runDir = join(ROOT, "run1")
  const sup = await Supervisor.start({ runDir, token: "t0k", services: [fake()], pollMs: 50 })
  try {
    await new Promise((done) => setTimeout(done, 300))
    assert.equal(sup.status().comfyui!.state, "stopped", "auto, but lazy: nothing started yet")
    const client = new ComfyClient({ url: sup.urls.comfyui!, startingWaitMs: 20_000 })
    const info = await client.objectInfo()
    assert.equal(info.ok, true, JSON.stringify(info))
    assert.equal(sup.status().comfyui!.state, "running")
    const quick = await new ComfyClient({ url: sup.urls.comfyui!, startingWaitMs: 0 }).objectInfo()
    assert.equal(quick.ok, true, "running: no wait")
  } finally {
    await sup.close()
  }
})

test("a WebSocket upgrade goes through to the backend once it runs", async () => {
  const runDir = join(ROOT, "run2")
  const sup = await Supervisor.start({ runDir, services: [fake({ lazy: false })], pollMs: 50 })
  try {
    await until(() => sup.status().comfyui!.state === "running")
    const port = Number(new URL(sup.urls.comfyui!).port)
    const got = await new Promise<string>((done, fail) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET /ws?clientId=x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n")
      })
      let text = ""
      socket.on("data", (d) => {
        text += String(d)
        if (text.includes("101") && !text.includes("echo:")) socket.write("ping")
        if (text.includes("echo:ping")) {
          socket.destroy()
          done(text)
        }
      })
      socket.on("error", fail)
      setTimeout(() => fail(new Error(`no echo: ${text}`)), 5000)
    })
    assert.match(got, /101 Switching Protocols/)
    assert.match(got, /echo:ping/)
  } finally {
    await sup.close()
  }
})

test("the ComfyUI service: its Python and main.py, the GPU's environment, --cpu on the CPU", async () => {
  const spec = comfyService({ python: "/c/py", workspace: "/w", gpu: { id: "amd-igpu", name: "AMD Radeon (gfx1150, integrated)", env: { HSA_OVERRIDE_GFX_VERSION: "11.0.0" } } })
  assert.equal(spec.lazy, true)
  assert.equal(spec.open, true)
  assert.equal(spec.defaultDevice, "amd-igpu")
  assert.deepEqual((await spec.devices!()).map((d) => d.id), ["amd-igpu", "cpu"])
  const gpu = spec.command(9000, "amd-igpu")
  assert.deepEqual([gpu.cmd, gpu.args], ["/c/py", ["/w/main.py", "--listen", "127.0.0.1", "--port", "9000"]])
  assert.deepEqual(gpu.env, { HSA_OVERRIDE_GFX_VERSION: "11.0.0" })
  const cpu = spec.command(9000, "cpu")
  assert.equal(cpu.args.at(-1), "--cpu")
  assert.equal(cpu.env, undefined)
  const cpuOnly = comfyService({ python: "/c/py", workspace: "/w" })
  assert.deepEqual((await cpuOnly.devices!()).map((d) => d.id), ["cpu"])
  assert.equal(cpuOnly.command(1, undefined).args.at(-1), "--cpu")
})

test("registering ComfyUI adds it to the installed services in auto; without them there is nothing to add to", () => {
  const home = join(ROOT, "services")
  assert.equal(registerComfy({ python: "/p", workspace: "/w" }, home), false)
  mkdirSync(home, { recursive: true })
  const base: ServicesConfig = { decider: { bin: "/d", model: "/m" }, embedding: { server: [], gguf: "/g", url: "u", model: "e" }, modes: { decider: "auto", embedding: "off" } }
  writeFileSync(configPath(home), JSON.stringify(base))
  assert.equal(registerComfy({ python: "/p", workspace: "/w" }, home), true)
  const config = JSON.parse(readFileSync(configPath(home), "utf8")) as ServicesConfig
  assert.deepEqual(config.comfyui, { python: "/p", workspace: "/w" })
  assert.deepEqual(config.modes, { decider: "auto", embedding: "off", comfyui: "auto" })
  assert.deepEqual(hostServices(config, "t").map((s) => s.name), ["decider", "comfyui"], "no llama.cpp: no embedding, ComfyUI still")
})
