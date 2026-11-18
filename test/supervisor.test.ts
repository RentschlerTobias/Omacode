import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { readControl, STARTING_HEADER, Supervisor, type ServiceSpec } from "../container/supervisor.ts"

// A stand-in backend: answers /health once it is up, and echoes the Authorization header it was sent.
const FAKE = `
const http = require("node:http")
const port = Number(process.argv[1])
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("{}") }
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ auth: req.headers.authorization ?? null, body })) })
}).listen(port, "127.0.0.1")
`

const fake = (name: string): ServiceSpec => ({ name, command: (port) => ({ cmd: process.execPath, args: ["-e", FAKE, String(port)] }), startTimeoutMs: 10_000 })

const until = async (what: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((done) => setTimeout(done, 25))
  }
}

const post = (url: string, token?: string) =>
  fetch(`${url}/v1/x`, { method: "POST", body: "hello", headers: token ? { Authorization: `Bearer ${token}` } : {} })

test("a token guards the front, health stays open, and a running service is forwarded", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "sup-"))
  const sup = await Supervisor.start({ runDir, token: "t0k", services: [fake("decider")], pollMs: 50 })
  try {
    const url = sup.urls.decider!
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, "services.json"), "utf8")), { decider: url })
    assert.equal((await post(url)).status, 401)
    assert.equal((await post(url, "nope")).status, 401)
    assert.equal((await fetch(`${url}/health`)).status, 200)
    await until(() => sup.status().decider!.state === "running")
    const r = await post(url, "t0k")
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { auth: "Bearer t0k", body: "hello" }, "the token reaches the backend, which checks it too")
  } finally {
    await sup.close()
  }
})

test("auto stops after the idle time and the next request starts it again, saying so", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "sup-"))
  const sup = await Supervisor.start({ runDir, services: [fake("embedding")], idleMs: 300, pollMs: 50 })
  try {
    const url = sup.urls.embedding!
    await until(() => sup.status().embedding!.state === "running")
    await until(() => sup.status().embedding!.state === "stopped")
    assert.match(sup.status().embedding!.detail ?? "", /without a request/)
    const first = await post(url)
    assert.equal(first.status, 503)
    assert.equal(first.headers.get(STARTING_HEADER), "1")
    assert.ok(Number(first.headers.get("retry-after")) > 0)
    await until(() => sup.status().embedding!.state === "running")
    assert.equal((await post(url)).status, 200)
    const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as { services: Record<string, { state: string; mode: string }> }
    assert.equal(status.services.embedding!.mode, "auto")
  } finally {
    await sup.close()
  }
})

test("off from the control file stops the service and answers without the starting header; on brings it back", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "sup-"))
  const sup = await Supervisor.start({ runDir, services: [fake("decider")], pollMs: 50 })
  try {
    const url = sup.urls.decider!
    await until(() => sup.status().decider!.state === "running")
    writeFileSync(join(runDir, "control.json"), JSON.stringify({ decider: "off" }))
    await until(() => sup.status().decider!.state === "stopped")
    const r = await post(url)
    assert.equal(r.status, 503)
    assert.equal(r.headers.get(STARTING_HEADER), null, "off is not a start: the plugin falls back at once")
    writeFileSync(join(runDir, "control.json"), JSON.stringify({ decider: "on", idleMinutes: 5 }))
    await until(() => sup.status().decider!.state === "running")
    assert.equal(sup.status().decider!.mode, "on")
  } finally {
    await sup.close()
  }
})

test("a service that dies is reported as failed with where to look", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "sup-"))
  const dying: ServiceSpec = { name: "decider", command: () => ({ cmd: process.execPath, args: ["-e", "process.exit(3)"] }), startTimeoutMs: 5000 }
  const sup = await Supervisor.start({ runDir, services: [dying], pollMs: 50 })
  try {
    await until(() => sup.status().decider!.state === "failed")
    assert.match(sup.status().decider!.detail ?? "", /decider\.log/)
    const r = await post(sup.urls.decider!)
    assert.equal(r.status, 503)
    assert.match(((await r.json()) as { error: string }).error, /failed/)
  } finally {
    await sup.close()
  }
})

test("the control file keeps the defaults for anything it does not say", () => {
  const dir = mkdtempSync(join(tmpdir(), "sup-"))
  const path = join(dir, "control.json")
  assert.deepEqual(readControl(path, ["decider", "embedding"], { embedding: "off" }), { modes: { decider: "auto", embedding: "off" } })
  writeFileSync(path, JSON.stringify({ decider: "on", embedding: "sideways", idleMinutes: 2 }))
  assert.deepEqual(readControl(path, ["decider", "embedding"], {}), { modes: { decider: "on", embedding: "auto" }, idleMs: 120_000 })
  writeFileSync(path, "{ half")
  assert.deepEqual(readControl(path, ["decider"], {}), { modes: { decider: "auto" } })
})
