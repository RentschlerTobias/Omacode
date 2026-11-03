import assert from "node:assert/strict"
import test from "node:test"

import contextPlugin from "../packages/context/src/index.ts"
import { readStatus } from "../packages/context/src/status.ts"

function fakeCtx() {
  const hooks: Record<string, Function> = {}
  let listed = 0
  const ctx = {
    location: { directory: process.cwd() },
    model: { list: async () => (listed++, []) },
    session: {
      hook: async (name: string, cb: Function) => void (hooks[name] = cb),
    },
  }
  return { ctx, hooks, listed: () => listed }
}

test("the context plugin manages a session on its own and writes its status", async () => {
  const { ctx, hooks } = fakeCtx()
  await contextPlugin.setup(ctx, { memory: false })
  assert.equal(typeof hooks.context, "function")
  assert.equal(typeof hooks.prompt, "function")

  const input = {
    sessionID: "ses_context_plugin",
    agent: "build",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
    system: [{ type: "text", text: "be useful" }],
    model: { providerID: "test", id: "model" },
  }
  await hooks.context(input)

  const status = readStatus("ses_context_plugin")
  assert.ok(status, "the status file is written")
  assert.equal(status!.ceiling, 100_000)
  assert.equal(status!.epochs, 0)
})
