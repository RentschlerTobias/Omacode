// The /services menu and `services mode`: what they show from the supervisor's status file and what they write to its
// control file. The supervisor applying that file is test/supervisor.test.ts's.

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { readControl } from "../packages/core/src/supervisor.ts"
import { serviceLine, servicesView, setIdleMinutes, setServiceMode } from "../packages/core/src/service-control.ts"

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
  assert.deepEqual(readControl(join(dir, "control.json"), ["decider", "embedding"], {}), { modes: { decider: "on", embedding: "off" }, idleMs: 30 * 60_000 })

  const now = servicesView(env)
  assert.deepEqual(now.services.map((s) => s.mode), ["on", "off"], "the asked mode, not the last reported one")
  assert.equal(serviceLine(now.services[1]!), "off")
  assert.equal(now.idleMinutes, 30)
})

test("bad values are refused", () => {
  const env = { OMACODE_RUN_DIR: join(ROOT, "bad") }
  assert.throws(() => setServiceMode("decider", "sometimes" as never, env))
  assert.throws(() => setIdleMinutes(0, env))
})
