import assert from "node:assert/strict"
import test from "node:test"

import sandboxPlugin from "../packages/sandbox/src/plugin.ts"

function fakeCtx(records: Record<string, { parentID?: string }>) {
  const tool: Record<string, Function> = {}
  const shell: Record<string, Function> = {}
  const ctx = {
    tool: { hook: async (name: string, cb: Function) => void (tool[name] = cb) },
    shell: { hook: async (name: string, cb: Function) => void (shell[name] = cb) },
    session: { get: async ({ sessionID }: { sessionID: string }) => records[sessionID] },
  }
  return { ctx, tool, shell }
}

test("the sandbox plugin alone wraps a delegated child and leaves the root alone", async () => {
  const { ctx, tool, shell } = fakeCtx({
    child: { parentID: "root" },
    root: {},
  })
  await sandboxPlugin.setup(ctx, {
    sandbox: async () => ({ available: true, wrap: async (command: string) => `wrapped ${command}`, stop: async () => {} }),
  })

  const child = { tool: "shell", sessionID: "child", input: { command: "echo child" }, cwd: "/tmp" }
  await tool["execute.before"](child)
  const childShell = { command: "echo child", cwd: "/tmp" }
  await shell["create.before"](childShell)
  assert.equal(childShell.command, "wrapped echo child")

  const root = { tool: "shell", sessionID: "root", input: { command: "echo root" }, cwd: "/tmp" }
  await tool["execute.before"](root)
  const rootShell = { command: "echo root", cwd: "/tmp" }
  await shell["create.before"](rootShell)
  assert.equal(rootShell.command, "echo root")
})
