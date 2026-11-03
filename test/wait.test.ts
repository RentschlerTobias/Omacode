// The wait tool: a worker blocks on what it waits for instead of polling it.
//
// The live failure it answers: a worker starts a long command in the background and then polls it with `sleep`, and
// every poll is a shell command, so every poll asks the permission layer again and the worker is cut by the checkpoint
// before its command is done. One wait call replaces the loop: it blocks until the thing happened or the timeout ticks,
// and it says what happened, how long it waited, and what it was watching.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { Asks, type AskRequest } from "../packages/micromanager/src/ask.ts"
import { tempDir } from "./harness.ts"
import { installWaitTool, WAIT_ID, type ToolDraft } from "../packages/micromanager/src/tools.ts"
import { WAIT_DEFAULT_MS, waitFor, waitTimeoutMs, watchFile, watchPid } from "../packages/micromanager/src/wait.ts"

function fakeDraft() {
  const added: Record<string, unknown>[] = []
  const str = { kind: "string" }
  const draft: ToolDraft = {
    get: (id) => (id === "read" ? { input: { fields: { path: str }, mapFields: (f) => ({ mapped: f() }) } } : undefined),
    add: (tool) => added.push(tool),
  }
  return { draft, added, str }
}

const byId = (added: Record<string, unknown>[], id: string) => {
  const tool = added.find((t) => t.id === id)!
  return { input: tool.input, run: tool.execute as (a: Record<string, unknown>, c: object) => Promise<{ content: string }> }
}

// --- the tool itself ------------------------------------------------------------------------------------------

test("the wait tool is registered for the workers and refused for everybody else", async () => {
  const { draft, added, str } = fakeDraft()
  const calls: string[] = []
  installWaitTool(draft, async (args, ctx) => { calls.push(`${ctx.sessionID}:${JSON.stringify(args)}`); return "waited" }, (id) => id === "ses_worker")
  assert.ok(added.some((t) => t.id === WAIT_ID), "the tool is there")
  const tool = byId(added, WAIT_ID)
  assert.deepEqual(tool.input, { mapped: { id: str, pid: str, file: str, match: str, line: str, timeout: str } })
  assert.deepEqual(await tool.run({ pid: "12", file: "", match: "", line: "", timeout: "5", id: "" }, { agent: "coder", sessionID: "ses_worker" }), { content: "waited" })
  // A session that is not a worker of the micromanager never reaches the wait.
  assert.deepEqual(await tool.run({ pid: "12" }, { agent: "build", sessionID: "ses_user" }), { content: "Only a worker of the micromanager may use this tool." })
  assert.deepEqual(await tool.run({ pid: "12" }, { agent: "coder" }), { content: "Only a worker of the micromanager may use this tool." })
  assert.deepEqual(calls, ["ses_worker:{\"id\":\"\",\"pid\":\"12\",\"file\":\"\",\"match\":\"\",\"line\":\"\",\"timeout\":\"5\"}"])
})

// --- waiting on a process ------------------------------------------------------------------------------------

test("a wait on a pid blocks until the process is gone", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"], { stdio: "ignore" })
  const pid = child.pid!
  const started = Date.now()
  const result = await waitFor(watchPid(pid), 10_000)
  assert.equal(result.outcome, "done")
  assert.match(result.text, /the process \d+ has ended/)
  assert.ok(Date.now() - started < 10_000, "it waited for the process, not for the timeout")
})

test("a wait on a pid that is already gone says so at once", async () => {
  const result = await waitFor(watchPid(999_999), 5_000)
  assert.equal(result.outcome, "done")
  assert.match(result.text, /is already gone/)
})

// --- waiting on a file --------------------------------------------------------------------------------------

test("a wait on a file blocks until it holds the text it waits for", async () => {
  const dir = tempDir("wait-file-")
  const log = join(dir, "build.log")
  writeFileSync(log, "starting\n")
  const started = Date.now()
  const pending = waitFor(watchFile(log, "done"), 10_000)
  setTimeout(() => appendFileSync(log, "done\n"), 200)
  const result = await pending
  assert.equal(result.outcome, "done")
  assert.match(result.text, /holds "done"/)
  assert.ok(Date.now() - started >= 150, "it blocked until the text arrived")
})

test("a wait on a file waits for the line count it names, and for a file that is not there yet", async () => {
  const dir = tempDir("wait-line-")
  const log = join(dir, "later.log")
  const pending = waitFor(watchFile(log, undefined, 2), 10_000)
  setTimeout(() => appendFileSync(log, "one\n"), 100)
  setTimeout(() => appendFileSync(log, "two\n"), 200)
  const result = await pending
  assert.equal(result.outcome, "done")
  assert.match(result.text, /has 2 lines/)
})

// --- the timeout --------------------------------------------------------------------------------------------

test("a wait that times out says how long it waited and what it was watching", async () => {
  const dir = tempDir("wait-timeout-")
  const log = join(dir, "quiet.log")
  writeFileSync(log, "nothing yet\n")
  const result = await waitFor(watchFile(log, "never"), 1_000)
  assert.equal(result.outcome, "timeout")
  assert.match(result.text, /Timed out after 1s/)
  assert.match(result.text, /"never" in/, "it names what it was watching")
  assert.ok(result.waitedMs >= 250, "it waited as long as it said")
})

test("the timeout is a number of seconds, capped, and 60 seconds by default", () => {
  assert.equal(waitTimeoutMs(""), WAIT_DEFAULT_MS)
  assert.equal(waitTimeoutMs("30"), 30_000)
  assert.equal(waitTimeoutMs("2m"), 120_000)
  assert.equal(waitTimeoutMs("500ms"), 500)
  assert.equal(waitTimeoutMs("90"), 90_000)
  assert.equal(waitTimeoutMs("1h"), 10 * 60_000, "no wait lasts longer than ten minutes")
  assert.equal(waitTimeoutMs("nonsense"), WAIT_DEFAULT_MS)
  assert.equal(waitTimeoutMs("-5"), WAIT_DEFAULT_MS)
})

// --- waiting on a paused permission request ------------------------------------------------------------------

const REQ: AskRequest = {
  sessionID: "ses_w",
  parent: "ses_mm",
  task: "T2 Render the deck",
  agent: "coder",
  action: "shell",
  resources: ["chromium --headless --screenshot=/tmp/shot.png http://localhost:8123"],
  reason: "Jev unsure (0.60 < 0.85 for write)",
  hard: false,
}

test("a wait on a paused permission request ends when the request is answered", async () => {
  const asks = new Asks()
  const ask = asks.open(REQ, async () => {})
  const pending = waitFor({ done: asks.settled(ask.id, "ses_w")!.then((s) => ({ detail: `the request ${s.id} was ${s.decision} (${s.by})` })), progress: () => `the permission request ${ask.id}` }, 10_000)
  setTimeout(() => void asks.answer(ask.id, "once", "micromanager"), 100)
  const result = await pending
  assert.equal(result.outcome, "done")
  assert.match(result.text, /the request A1 was once \(micromanager\)/)
})

test("a worker finds its own paused request by label, and the settled promise tells how it ended", async () => {
  const asks = new Asks()
  const ask = asks.open(REQ, async () => {})
  assert.equal(asks.find("A1", "ses_w")?.id, "A1")
  assert.equal(asks.find("chromium", "ses_w")?.id, "A1", "a short label of what was asked finds it")
  assert.equal(asks.find("A1", "ses_other")?.id, "A1", "the id is the id")
  assert.equal(asks.find("nothing", "ses_w"), undefined)
  const settled = asks.settled("A1", "ses_w")!
  await asks.answer(ask.id, "refuse", "user", "not that server")
  const s = await settled
  assert.equal(s.id, "A1")
  assert.equal(s.decision, "refuse")
  assert.equal(s.by, "user")
  assert.match(s.note, /not that server/)
})

test("a worker sees its own paused requests and only those", () => {
  const asks = new Asks()
  const first = asks.open(REQ, async () => {})
  const second = asks.open({ ...REQ, resources: ["curl https://example.com"] }, async () => {})
  asks.open({ ...REQ, sessionID: "ses_other" }, async () => {})
  assert.deepEqual(asks.mine("ses_w").map((a) => a.id), [first.id, second.id])
  assert.deepEqual(asks.mine("ses_nobody"), [])
})

test("a request that is dropped settles its wait as void, not as an answer", async () => {
  const asks = new Asks()
  const ask = asks.open(REQ, async () => {})
  const settled = asks.settled(ask.id, "ses_w")!
  await asks.drop(["ses_w"], "the worker that asked it has ended")
  const s = await settled
  assert.equal(s.decision, "refuse")
  assert.match(s.note, /void/)
})
