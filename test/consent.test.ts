// Consent before something omacode would keep local goes to a cloud model (packages/core/src/consent.ts), and the
// guard's use of it for a request whose names could not be checked (packages/guard/src/wire.ts).

import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"

import { tempDir } from "./harness.ts"

// The guard journals its consent through @omacode/core/journal, which writes to the user's state directory: the tests
// must never land there (a first run of this file put a fake consent into the real journal, 2026-11-25).
const stateBefore = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = tempDir("consent-state-")
after(() => {
  if (stateBefore === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = stateBefore
})

import { askConsent, CONSENT_ACTION, consentGiven, isLoopback, resetConsent, rootSession, type ConsentHost } from "../packages/core/src/consent.ts"
import { installGuard, NotSent, redactHttpRequest } from "../packages/micromanager/src/guard/wire.ts"
import { Vault } from "../packages/micromanager/src/redact.ts"

beforeEach(() => resetConsent())

function host(answer: boolean | (() => Promise<void>)) {
  const asked: { action: string; resources: readonly string[]; sessionID?: string; metadata?: Record<string, unknown> }[] = []
  const h: ConsentHost = {
    permission: {
      assert: async (args) => {
        asked.push(args)
        if (typeof answer === "function") return answer()
        if (!answer) throw new Error("rejected")
      },
    },
  }
  return { h, asked }
}

const request = (scope: string, notes?: string[]) => ({
  kind: "unchecked" as const,
  scope,
  sessionID: scope,
  title: "Send?",
  text: `details for ${scope}`,
  note: async (_id: string, text: string) => notes?.push(text),
})

test("one question per scope: the answer holds for every later request, a refusal too", async () => {
  const yes = host(true)
  const notes: string[] = []
  assert.equal(await askConsent(yes.h, request("ses_a", notes)), true)
  assert.equal(await askConsent(yes.h, request("ses_a", notes)), true)
  assert.equal(yes.asked.length, 1, "asked once")
  assert.deepEqual(notes, ["details for ses_a"], "the details went into the conversation once")
  assert.equal(yes.asked[0]!.action, CONSENT_ACTION)
  assert.deepEqual(yes.asked[0]!.resources, ["ses_a"])
  assert.equal(consentGiven("unchecked", "ses_a"), true)
  assert.equal(consentGiven("sensitive", "ses_a"), undefined, "a kind of its own")

  const no = host(false)
  assert.equal(await askConsent(no.h, request("ses_b")), false)
  assert.equal(await askConsent(no.h, request("ses_b")), false)
  assert.equal(no.asked.length, 1, "a refused scope is not asked again either")
})

test("requests that arrive while the question is open wait for the same answer", async () => {
  let release!: () => void
  const open = new Promise<void>((r) => (release = r))
  const slow = host(() => open)
  const all = Promise.all([askConsent(slow.h, request("ses_c")), askConsent(slow.h, request("ses_c")), askConsent(slow.h, request("ses_c"))])
  await new Promise((r) => setTimeout(r, 5))
  release()
  assert.deepEqual(await all, [true, true, true])
  assert.equal(slow.asked.length, 1)
})

test("a worker's request is asked in the session the user started", async () => {
  const sessions: Record<string, { parentID?: string }> = { ses_worker: { parentID: "ses_micro" }, ses_micro: {} }
  assert.equal(await rootSession(async (id) => sessions[id], "ses_worker"), "ses_micro")
  assert.equal(await rootSession(async () => { throw new Error("gone") }, "ses_x"), "ses_x", "a failed lookup ends the walk")
})

test("loopback is this machine, anything else leaves it", () => {
  for (const url of ["http://127.0.0.1:8000/v1/chat", "http://localhost:11434/api", "http://[::1]:8080/"]) assert.equal(isLoopback(url), true, url)
  for (const url of ["https://opencode.ai/zen/go/v1/chat", "http://0.0.0.0:8000/", "http://192.168.1.5:8000/", "not a url"]) assert.equal(isLoopback(url), false, url)
})

// --- the guard: names unchecked because the decider is down ----------------------------------------------------------

const DOWN = { url: "http://127.0.0.1:9/v1/entities", labels: { "person name": "person" as const }, threshold: 0.5 }
const body = { model: "m", messages: [{ role: "user", content: "write to Jana Weber" }] }
const to = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const vault = () => new Vault({ path: null, secrets: true, pii: true })

test("with the decider down, a cloud request asks; no refuses it, yes sends it", async () => {
  let asked = 0
  await assert.rejects(redactHttpRequest(to("https://api.example.test/v1/messages"), vault(), DOWN, undefined, new Set(), async () => (asked++, false)), NotSent)
  assert.equal(asked, 1)
  const sent = await redactHttpRequest(to("https://api.example.test/v1/messages"), vault(), DOWN, undefined, new Set(), async () => (asked++, true))
  assert.match(await sent.text(), /Jana Weber/, "sent as it is: the name could not be found")
  assert.equal(asked, 2)
})

test("a local model is never asked about: the names stay on this machine", async () => {
  let asked = 0
  const sent = await redactHttpRequest(to("http://127.0.0.1:8000/v1/chat/completions"), vault(), DOWN, undefined, new Set(), async () => (asked++, false))
  assert.equal(asked, 0)
  assert.match(await sent.text(), /Jana Weber/)
})

test("the guard puts the question to the root session once, and OpenCode is told to ask", async () => {
  const hooks = new Map<string, (event: any) => unknown>()
  const evaluate: ((e: any) => void)[] = []
  const asserted: { sessionID?: string; resources: readonly string[] }[] = []
  const notes: string[] = []
  const ctx = {
    session: {
      hook: (name: string, fn: (event: any) => unknown) => void hooks.set(name, fn),
      get: async ({ sessionID }: { sessionID: string }) => (sessionID === "ses_worker" ? { parentID: "ses_micro" } : {}),
      synthetic: async ({ sessionID, text }: { sessionID: string; text: string }) => void notes.push(`${sessionID}: ${text.slice(0, 30)}`),
    },
    permission: {
      hook: (_name: string, fn: (e: any) => void) => void evaluate.push(fn),
      assert: async (args: { sessionID?: string; resources: readonly string[] }) => void asserted.push(args),
    },
  }
  installGuard(ctx, { getVault: () => vault(), getNames: () => DOWN })
  for (let i = 0; i < 3; i++) await hooks.get("http.request")!({ sessionID: "ses_worker", request: to("https://api.example.test/v1/messages") })
  assert.equal(asserted.length, 1, "three requests, one question")
  assert.equal(asserted[0]!.sessionID, "ses_micro")
  assert.deepEqual(asserted[0]!.resources, ["ses_micro"])
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, /^ses_micro: \[omacode\] The decider is not/)
  // Whatever OpenCode's rules say for an unknown action, the consent is asked, never allowed by default; a deny stays.
  const evaluation = { action: CONSENT_ACTION, effect: "allow", metadata: { title: "Send?" } } as { action: string; effect: string; message?: string; metadata: Record<string, unknown> }
  evaluate[0]!(evaluation)
  assert.equal(evaluation.effect, "ask")
  assert.equal(evaluation.message, "Send?")
  const denied = { action: CONSENT_ACTION, effect: "deny", metadata: {} }
  evaluate[0]!(denied)
  assert.equal(denied.effect, "deny")
})
