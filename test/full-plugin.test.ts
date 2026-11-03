import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import guard from "../packages/guard/src/plugin.ts"
import full from "../packages/full/src/plugin.ts"

function fakeCtx() {
  const hooks: Record<string, Function[]> = {}
  const add = (n: string, cb: Function) => void (hooks[n] ??= []).push(cb)
  return {
    hooks,
    ctx: {
      location: { directory: process.cwd() },
      session: { hook: async (n: string, cb: Function) => add(n, cb) },
      tool: { hook: async (n: string, cb: Function) => add(`tool:${n}`, cb) },
      shell: { hook: async (n: string, cb: Function) => add(`shell:${n}`, cb) },
      model: { list: async () => [] },
    },
  }
}

test("the full package composes guard, sandbox, context and the orchestrator once", async () => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "mm-full-state-"))
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mm-full-config-"))
  const { ctx, hooks } = fakeCtx()
  let orchestrator = 0
  const fakeManager = { setup: async () => void (orchestrator += 1) }
  await guard.setup(ctx, {})
  await full.setup(ctx, { context: { memory: false }, micromanager: fakeManager })
  const first = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]))
  await full.setup(ctx, { context: { memory: false }, micromanager: fakeManager })
  const second = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]))
  assert.deepEqual(second, first, "a second setup must not register the same hooks again")
  assert.equal(hooks["context"]?.length, 2, "guard and context each own one context hook")
  assert.equal(hooks["http.request"]?.length, 1, "the guard installed before full is not installed twice")
  assert.equal(hooks["shell:create.before"]?.length, 1)
  assert.ok(orchestrator >= 1, "the orchestrator is composed into full")
})
