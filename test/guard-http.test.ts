import assert from "node:assert/strict"
import { test } from "node:test"
import { installGuard, redactHttpRequest } from "../packages/micromanager/src/guard/wire.ts"
import { PLACEHOLDER_NOTE, Vault } from "../packages/micromanager/src/redact.ts"

const SECRET = "sk-test-0123456789abcdefghij"

function vault(): Vault {
  return new Vault({ path: null, secrets: true, pii: true })
}

function request(body: unknown, type = "application/json"): Request {
  return new Request("https://api.example.test/v1/messages", {
    method: "POST",
    headers: { "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function fakeCtx(): { hooks: Map<string, (event: any) => unknown>; ctx: unknown } {
  const hooks = new Map<string, (event: any) => unknown>()
  return {
    hooks,
    ctx: {
      session: {
        hook: (name: string, fn: (event: any) => unknown) => {
          hooks.set(name, fn)
        },
      },
    },
  }
}

test("the http.request hook redacts a model body before it goes out", async () => {
  const v = vault()
  const { hooks, ctx } = fakeCtx()
  installGuard(ctx, { getVault: () => v, getNames: () => undefined })

  const event = { request: request({ model: "m", messages: [{ role: "user", content: `key ${SECRET}` }] }) }
  await hooks.get("http.request")!(event)

  assert.notEqual(event.request, undefined)
  const text = await event.request.text()
  assert.equal(text.includes(SECRET), false, "the secret is gone")
  assert.match(text, /SECRET_\d+/, "a placeholder took its place")
  assert.equal(event.request.method, "POST")
  assert.equal(event.request.url, "https://api.example.test/v1/messages")
  assert.match(event.request.headers.get("content-type") ?? "", /json/)
})

test("the request keeps its structure and gains the placeholder note", async () => {
  const v = vault()
  const body = {
    model: "m",
    system: "be careful",
    messages: [
      { role: "user", content: `mail me at ${SECRET}` },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
    tools: [{ name: "read", description: "read a file" }],
  }
  const out = await redactHttpRequest(request(body), v)
  const parsed = JSON.parse(await out.text())
  assert.equal(parsed.model, "m")
  assert.equal(parsed.tools[0].name, "read")
  assert.match(parsed.messages[0].content, /SECRET_\d+/)
  assert.match(parsed.system, new RegExp(PLACEHOLDER_NOTE.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("a non-model JSON request is left alone", async () => {
  const v = vault()
  const original = request({ query: `anything ${SECRET}` })
  const out = await redactHttpRequest(original, v)
  assert.equal(out, original)
})

test("a non-JSON request is left alone", async () => {
  const v = vault()
  const original = request(`key=${SECRET}`, "application/x-www-form-urlencoded")
  const out = await redactHttpRequest(original, v)
  assert.equal(out, original)
})

test("no vault means no hook work", async () => {
  const { hooks, ctx } = fakeCtx()
  installGuard(ctx, { getVault: () => undefined, getNames: () => undefined })
  const original = request({ messages: [{ role: "user", content: `key ${SECRET}` }] })
  const event = { request: original }
  await hooks.get("http.request")!(event)
  assert.equal(event.request, original)
})

test("http.response restores the placeholder the request carried", async () => {
  const v = vault()
  const email = "alice@acme.io"
  const placeholder = v.add(email, "email")
  assert.ok(placeholder)
  const { hooks, ctx } = fakeCtx()
  installGuard(ctx, { getVault: () => v, getNames: () => undefined })

  const event = {
    response: new Response(JSON.stringify({ content: `mail ${placeholder}` }), {
      headers: { "content-type": "application/json" },
    }),
  }
  await hooks.get("http.response")!(event)
  const text = await event.response.text()
  assert.equal(text.includes(email), true)
  assert.equal(text.includes(placeholder!), false)
})
