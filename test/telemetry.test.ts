// No usage reports from what omacode starts (core/telemetry.ts, the user's decision of 2026-11-24): the opt-outs are in
// a worker's cleaned environment, in every HyperFrames run, and in what the runner is allowed to hand on.

import assert from "node:assert/strict"
import { test } from "node:test"

import { TELEMETRY_OFF, TELEMETRY_OFF_NAMES, withoutTelemetry } from "../packages/core/src/telemetry.ts"
import { cleanEnv } from "../packages/sandbox/src/sandbox.ts"
import { HYPERFRAMES_ENV, HYPERFRAMES_ENV_NAMES } from "../packages/artifact/src/adapters/hyperframes.ts"

test("the opt-outs: the common one, HyperFrames' own, and the agent tooling one", () => {
  assert.deepEqual(TELEMETRY_OFF, { DO_NOT_TRACK: "1", HYPERFRAMES_NO_TELEMETRY: "1", DISABLE_TELEMETRY: "1" })
  assert.deepEqual(withoutTelemetry({ PATH: "/bin", DO_NOT_TRACK: "0" }), { PATH: "/bin", ...TELEMETRY_OFF }, "set, whatever the environment said")
})

test("a worker's cleaned environment always carries them, even when the host's does not", () => {
  const env = cleanEnv({ PATH: "/usr/bin", HOME: "/home/u", SECRET_TOKEN: "x" })
  for (const [name, value] of Object.entries(TELEMETRY_OFF)) assert.equal(env[name], value, name)
  assert.equal(env["SECRET_TOKEN"], undefined, "the cleaning itself is unchanged")
})

test("every HyperFrames run carries them, and the runner may hand them on", () => {
  for (const [name, value] of Object.entries(TELEMETRY_OFF)) assert.equal((HYPERFRAMES_ENV as Record<string, string>)[name], value, name)
  for (const name of TELEMETRY_OFF_NAMES) assert.ok((HYPERFRAMES_ENV_NAMES as readonly string[]).includes(name), name)
})
