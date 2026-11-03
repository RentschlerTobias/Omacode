import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { tempDir } from "./harness.ts"
import guard from "../src/guard/index.ts"
import { loadGuardSettings } from "../packages/guard/src/config.ts"

function withConfig(guardText: string | undefined, fallbackText: string | undefined): { config: string; state: string } {
  const config = tempDir("mm-config-")
  const state = tempDir("mm-state-")
  const dir = join(config, "opencode")
  mkdirSync(dir, { recursive: true })
  if (guardText !== undefined) writeFileSync(join(dir, "guard.jsonc"), guardText)
  if (fallbackText !== undefined) writeFileSync(join(dir, "micromanager.jsonc"), fallbackText)
  process.env.XDG_CONFIG_HOME = config
  process.env.XDG_STATE_HOME = state
  return { config, state }
}

function fakeCtx() {
  const hooks = new Map<string, (event: any) => unknown>()
  return {
    hooks,
    ctx: {
      session: {
        hook: (name: string, fn: (event: any) => unknown) => hooks.set(name, fn),
      },
    },
  }
}

test("guard reads its own guard.jsonc and needs no micromanager config", async () => {
  const old = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME }
  try {
    withConfig('{ "secrets": true, "pii": false, "names": false }', undefined)
    const settings = loadGuardSettings()
    assert.equal(settings.secrets, true)
    assert.equal(settings.pii, false)
    assert.equal(settings.names, false)
  } finally {
    process.env.XDG_CONFIG_HOME = old.config
    process.env.XDG_STATE_HOME = old.state
  }
})

test("guard falls back to the redact block of micromanager.jsonc", () => {
  const old = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME }
  try {
    withConfig(undefined, '{ "redact": { "names": true, "threshold": 0.4 }, "parallel": 3 }')
    const settings = loadGuardSettings()
    assert.equal(settings.names, true)
    assert.equal(settings.threshold, 0.4)
  } finally {
    process.env.XDG_CONFIG_HOME = old.config
    process.env.XDG_STATE_HOME = old.state
  }
})

test("guard installed alone redacts a model request before it leaves", async () => {
  const old = { config: process.env.XDG_CONFIG_HOME, state: process.env.XDG_STATE_HOME }
  try {
    withConfig('{ "secrets": true, "pii": true, "names": false }', undefined)
    const { hooks, ctx } = fakeCtx()
    guard.setup(ctx)
    const secret = "sk-live-1234567890abcdef"
    const request = new Request("https://api.example.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: `token ${secret} is here` }] }),
    })
    const event: { request: Request } = { request }
    await hooks.get("http.request")!(event)
    const body = await event.request.text()
    assert.equal(body.includes(secret), false)
    assert.match(body, /SECRET_\d+/)
    assert.equal(event.request.url, request.url)
    assert.equal(event.request.method, "POST")
  } finally {
    process.env.XDG_CONFIG_HOME = old.config
    process.env.XDG_STATE_HOME = old.state
  }
})
