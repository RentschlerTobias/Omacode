import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"

import { tempDir } from "./harness.ts"

import guard from "../src/guard/index.ts"
import shell, { isChildShell } from "../src/shell/index.ts"
import worktree, { worktreeApi } from "../src/worktree/index.ts"
import context from "../src/context/index.ts"
import plugin from "../src/plugin.ts"
import { resetClaims } from "@omacode/core/registry"

beforeEach(() => resetClaims())

const PROJECT = "/home/t1dde/Fun/Projects/Repos/micromanager"

function makeMockCtx() {
  const hooks: Record<string, ((arg: any) => Promise<void>)[]> = {}
  const draft = { list: () => [], get: () => undefined, namespace: () => {}, add: () => {}, update: () => {}, remove: () => {} }
  const noop = async () => undefined
  return {
    hooks,
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
    shell: { hook: async (n: string, cb: (a: any) => Promise<void>) => { (hooks[`shell:${n}`] ??= []).push(cb) } },
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

test("the shell plugin on its own wraps the shells of a child session", async () => {
  const ctx = makeMockCtx()
  await shell.setup(ctx as never)
  // The shell plugin installs its own shell hook: the one that wraps a child's command in the sandbox.
  assert.equal((ctx.hooks["shell:create.before"] ?? []).length, 1, "the shell plugin hooks the shell")
  // And it notes the commands of the child sessions in the tool hook, because the shell hook gets no session id.
  assert.equal((ctx.hooks["execute.before"] ?? []).length, 1, "the shell plugin hooks the tool")
})

test("the worktree plugin on its own publishes the worktree handling", async () => {
  const ctx = makeMockCtx()
  await worktree.setup(ctx as never)
  const api = worktreeApi()
  assert.ok(api, "the worktree plugin publishes its handling")
  assert.equal(typeof api.prepareTaskWorktree, "function")
  assert.equal(typeof api.prepareIntegration, "function")
  assert.equal(typeof api.rebaseTask, "function")
  assert.equal(typeof api.fastForward, "function")
  assert.equal(typeof api.frozenChanged, "function")
  assert.equal(typeof api.commitTask, "function")
})

test("the shell plugin's decision wraps a child of any plugin and not the user's own shell", () => {
  const child = { tool: "shell", sessionID: "ses_child" }
  const root = { tool: "shell", sessionID: "ses_root" }
  assert.equal(isChildShell(child, { parentID: "ses_some_other_plugin" }), true)
  assert.equal(isChildShell(root, {}), false)
})
