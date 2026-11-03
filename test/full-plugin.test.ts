import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

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

test("the full package composes guard, sandbox and context once", async () => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "mm-full-state-"))
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mm-full-config-"))
  const { ctx, hooks } = fakeCtx()
  await full.setup(ctx, { context: { memory: false } })
  const first = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]))
  await full.setup(ctx, { context: { memory: false } })
  const second = Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]))
  assert.deepEqual(second, first, "a second setup must not register the same hooks again")
  assert.equal(hooks["context"]?.length, 2, "guard and context each own one context hook")
  assert.equal(hooks["http.request"]?.length, 1)
  assert.equal(hooks["shell:create.before"]?.length, 1)
})
