import assert from "node:assert/strict"
import { test } from "node:test"

import { tempDir } from "./harness.ts"

import guard from "../src/guard/index.ts"
import shell from "../src/shell/index.ts"
import worktree from "../src/worktree/index.ts"
import context from "../src/context/index.ts"
import plugin from "../src/plugin.ts"

const PROJECT = "/home/t1dde/Fun/Projects/Repos/micromanager"

function makeMockCtx() {
  const hooks: Record<string, ((arg: any) => Promise<void>)[]> = {}
  const draft = { list: () => [], get: () => undefined, namespace: () => {}, add: () => {}, update: () => {}, remove: () => {} }
  const noop = async () => undefined
  return {
    location: { directory: PROJECT },
    app: {},
    agent: { transform: async (cb: (d: unknown) => void) => cb(draft) },
    tool: { hook: async (n: string, cb: (a: any) => Promise<void>) => { (hooks[n] ??= []).push(cb) }, transform: async (cb: (d: unknown) => void) => cb(draft) },
    permission: { hook: async (n: string, cb: (a: any) => Promise<void>) => { (hooks[`perm:${n}`] ??= []).push(cb) } },
    session: {
      hook: async (n: string, cb: (a: any) => Promise<void>) => { (hooks[`sess:${n}`] ??= []).push(cb) },
      get: async () => undefined,
      synthetic: noop, move: noop, create: noop, prompt: noop, wait: noop, context: noop, interrupt: noop,
    },
    skill: { transform: async (_cb: any) => undefined },
    model: { list: async () => [] },
  }
}

test("each entry point can be set up standalone", async (t) => {
  const before = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = tempDir("jev-plugin-")
  const stderr = console.error
  console.error = () => {}
  t.after(() => {
    console.error = stderr
    if (before === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = before
  })

  for (const entry of [guard, shell, worktree, context]) {
    await entry.setup(makeMockCtx() as never)
  }
})

test("the default export still has id micromanager and a setup function", () => {
  assert.equal(plugin.id, "micromanager")
  assert.equal(typeof plugin.setup, "function")
})

test("each entry has a distinct id", () => {
  const ids = [guard.id, shell.id, worktree.id, context.id]
  assert.equal(new Set(ids).size, ids.length)
})
