import assert from "node:assert/strict"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { gateFor } from "../packages/micromanager/src/gatebox.ts"
import { runGate } from "../packages/micromanager/src/integration.ts"
import type { Rules, Wrapper } from "../packages/micromanager/src/sandbox.ts"
import { planRoot } from "../packages/micromanager/src/writeguard.ts"
import { tempDir } from "./harness.ts"

const ROOT = tempDir("mm-gatebox-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

// The box as startSandbox reports it when it cannot run, and as it wraps when it can: the arguments of the wrap are
// what a check would run under, so the test reads them.
function unavailable(): Wrapper {
  return { available: false, reason: "switched off", wrap: async (c) => c, stop: async () => undefined }
}
function recording(seen: { command: string; rules: Rules }[], tag = "wrapped"): Wrapper {
  return {
    available: true,
    wrap: async (command, rules) => {
      seen.push({ command, rules })
      return `${tag}: ${command}`
    },
    stop: async () => undefined,
  }
}

test("with no sandbox the gate says why and wraps nothing, so no check runs outside it", async () => {
  const gate = await gateFor(
    { box: async () => unavailable(), grants: () => ({ domains: [], env: [] }) },
    { project: join(ROOT, "project"), jobId: "job-1", plan: false, writer: true, role: "code", worktree: join(ROOT, "worktree"), dir: join(ROOT, "worktree") },
  )
  assert.match(gate.skip!, /no sandbox on this machine/)
  assert.match(gate.skip!, /switched off/)
  assert.deepEqual(gate.env, {}, "nothing is handed on")
  assert.equal(await gate.wrap("npm test"), "npm test", "the command is not wrapped")
})

test("with no sandbox but the user's confirmation, the check runs unwrapped, marked and with a cleaned environment", async () => {
  const before = { secret: process.env.SECRET_TOKEN, granted: process.env.MM_GRANTED_TOKEN }
  process.env.SECRET_TOKEN = "shh"
  process.env.MM_GRANTED_TOKEN = "granted"
  try {
    const gate = await gateFor(
      { box: async () => unavailable(), grants: () => ({ domains: [], env: ["MM_GRANTED_TOKEN"] }), unsandboxed: (project, jobId) => project === join(ROOT, "project") && jobId === "job-1" },
      { project: join(ROOT, "project"), jobId: "job-1", plan: false, writer: true, role: "code", worktree: join(ROOT, "worktree"), dir: join(ROOT, "worktree") },
    )
    assert.equal(gate.skip, undefined, "the check is not skipped: the user said it may run")
    assert.equal(gate.unsandboxed, true, "and every result says it ran without a box")
    assert.equal(await gate.wrap("npm test"), "npm test", "the command is not wrapped at all")
    assert.equal(gate.env.MM_GRANTED_TOKEN, "granted", "a granted variable is handed on")
    assert.equal(gate.env.SECRET_TOKEN, undefined, "a secret nobody granted is still dropped")
    assert.equal(gate.env.PATH, process.env.PATH, "the ordinary environment survives")
    // Another job of the same project has no grant: its check is skipped, as fail-closed A1 has it.
    const other = await gateFor(
      { box: async () => unavailable(), grants: () => ({ domains: [], env: [] }), unsandboxed: () => false },
      { project: join(ROOT, "project"), jobId: "job-2", plan: false, writer: true, role: "code", worktree: join(ROOT, "worktree"), dir: join(ROOT, "worktree") },
    )
    assert.match(other.skip ?? "", /no sandbox on this machine/)
    assert.equal(other.unsandboxed, undefined)
  } finally {
    if (before.secret === undefined) delete process.env.SECRET_TOKEN
    else process.env.SECRET_TOKEN = before.secret
    if (before.granted === undefined) delete process.env.MM_GRANTED_TOKEN
    else process.env.MM_GRANTED_TOKEN = before.granted
  }
})

test("a check that ran without a box says so in its result", async () => {
  const gate = await gateFor(
    { box: async () => unavailable(), grants: () => ({ domains: [], env: [] }), unsandboxed: () => true },
    { project: join(ROOT, "project"), jobId: "job-1", plan: false, writer: true, role: "code", worktree: join(ROOT, "worktree"), dir: join(ROOT, "worktree") },
  )
  const [result] = await runGate(join(ROOT, "worktree"), ["true"], async () => ({ code: 0, stdout: "", stderr: "" }), 5000, join(ROOT, "worktree"), {}, gate)
  assert.equal(result!.passed, true)
  assert.equal(result!.unsandboxed, true, "the stage line and the note can say how it ran")
})

test("with a sandbox the gate wraps the command in the worker's own rules, with its grants and a cleaned environment", async () => {
  const project = join(ROOT, "project-ok")
  const worktree = join(ROOT, "worktrees", "job-1--T1")
  mkdirSync(worktree, { recursive: true })
  const seen: { command: string; rules: Rules }[] = []
  const before = { secret: process.env.SECRET_TOKEN, granted: process.env.MM_GRANTED_TOKEN }
  process.env.SECRET_TOKEN = "shh"
  process.env.MM_GRANTED_TOKEN = "granted"
  try {
    const gate = await gateFor(
      { box: async () => recording(seen), grants: () => ({ domains: ["api.example.com"], env: ["MM_GRANTED_TOKEN"] }) },
      { project, jobId: "job-1", plan: false, writer: true, role: "code", worktree, dir: worktree },
    )
    assert.equal(gate.skip, undefined)
    const wrapped = await gate.wrap("npm test")
    assert.match(wrapped, /^wrapped: /)
    assert.match(wrapped, /TMPDIR=/, "the check gets the worker's own temp directory")
    assert.match(wrapped, /npm test$/)
    assert.equal(seen.length, 1)
    assert.match(seen[0]!.command, /(^|; )npm test$/, "the command itself is what is wrapped")
    const rules = seen[0]!.rules
    assert.ok(rules.filesystem.allowWrite.includes(worktree), "its own worktree is writable")
    assert.ok(!rules.filesystem.allowWrite.includes(project), "the project is not")
    assert.ok(rules.network.allowedDomains.includes("api.example.com"), "the job's grants reach the network")
    assert.equal(gate.env.MM_GRANTED_TOKEN, "granted", "a granted variable is handed on")
    assert.equal(gate.env.SECRET_TOKEN, undefined, "a secret nobody granted is dropped")
    assert.equal(gate.env.PATH, process.env.PATH, "the ordinary environment survives")
    assert.equal(gate.env.CI, "1")
  } finally {
    if (before.secret === undefined) delete process.env.SECRET_TOKEN
    else process.env.SECRET_TOKEN = before.secret
    if (before.granted === undefined) delete process.env.MM_GRANTED_TOKEN
    else process.env.MM_GRANTED_TOKEN = before.granted
  }
})

test("a plan job's gate writes only the plan area, never the project", async () => {
  const project = join(ROOT, "project-plan")
  const worktree = join(planRoot(project), "worktrees", "job-1--T1")
  mkdirSync(worktree, { recursive: true })
  const seen: { command: string; rules: Rules }[] = []
  const gate = await gateFor(
    { box: async () => recording(seen), grants: () => ({ domains: [], env: [] }) },
    { project, jobId: "job-1", plan: true, writer: true, role: "investigator", worktree, dir: worktree },
  )
  await gate.wrap("true")
  const rules = seen[0]!.rules
  assert.equal(rules.filesystem.allowWrite[0], planRoot(project), "the plan root is the one writable place")
  assert.ok(!rules.filesystem.allowWrite.includes(project), "the project itself is read-only")
  assert.ok(!rules.filesystem.allowWrite.includes(worktree), "not even the plan worktree is named apart")
})
