import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import guard from "../packages/guard/src/plugin.ts"
import full from "../packages/full/src/plugin.ts"
import { claim, resetClaims } from "../packages/core/src/registry.ts"

function fakeCtx(directory: string = process.cwd()) {
  const hooks: Record<string, Function[]> = {}
  const add = (n: string, cb: Function) => void (hooks[n] ??= []).push(cb)
  return {
    hooks,
    ctx: {
      location: { directory },
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

// A server boots one location per directory and calls setup for each of them. One process-wide claim let only the
// first through: the second project got no agent, no sandbox and no guard, and said nothing (2026-11-17).
test("every location the server boots gets its own install", async () => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "mm-full-state-"))
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mm-full-config-"))
  const first = fakeCtx(mkdtempSync(join(tmpdir(), "mm-loc-a-")))
  const second = fakeCtx(mkdtempSync(join(tmpdir(), "mm-loc-b-")))
  let orchestrator = 0
  const fakeManager = { setup: async () => void (orchestrator += 1) }

  await full.setup(first.ctx, { context: { memory: false }, micromanager: fakeManager })
  await full.setup(second.ctx, { context: { memory: false }, micromanager: fakeManager })

  assert.equal(orchestrator, 2, "a second location is a second install")
  assert.equal(second.hooks["http.request"]?.length, 1, "the guard installs at the second location too")
  assert.equal(second.hooks["context"]?.length, 2, "guard and context each own one context hook there")
  assert.equal(second.hooks["shell:create.before"]?.length, 1, "the sandbox wraps commands there too")
})

test("claim is per location, not per process", () => {
  resetClaims()
  assert.equal(claim("probe", "/a"), true, "the first location installs")
  assert.equal(claim("probe", "/a"), false, "the same location does not install twice")
  assert.equal(claim("probe", "/b"), true, "a second location installs on its own")
  assert.equal(claim("probe"), true, "no location keeps the per-process behaviour")
  assert.equal(claim("probe"), false, "and is still once per process")
  resetClaims()
})
