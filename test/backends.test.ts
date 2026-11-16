import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_BACKENDS, Decider, backendNotes, cloudKey, label, makeAskers, type Asker, type BackendName } from "../packages/micromanager/src/backends.ts"
import { glinerRows, openJevRows, renderState, splitOf } from "../packages/micromanager/src/dataset.ts"
import { evaluate } from "../packages/micromanager/src/eval.ts"
import type { Decision, Question } from "../packages/micromanager/src/decider.ts"
import type { Entry } from "../packages/micromanager/src/journal.ts"

const QUESTIONS: Record<string, Question> = {
  role: { type: "choice", instructions: "Which role fits?", criteria: { code: "writes code", explore: "reads only" } },
  harmful: { type: "noul", instructions: "This task asks for help to hurt people." },
}

const fixed = (answers: Decision["answers"], calls: string[] = [], name = "x"): Asker => ({
  async ask(state) {
    calls.push(`${name}:${state}`)
    return { answers, model: name, latencyMs: 5 }
  },
})
const failing: Asker = { async ask() { throw new Error("down") } }

const jevAnswers: Decision["answers"] = {
  role: { type: "choice", choice: "code", confidence: 0.9, probabilities: { code: 0.9, explore: 0.1 } },
  harmful: { type: "noul", noul: 0.05 },
}

function decider(askers: Partial<Record<BackendName, Asker>>, shadow?: BackendName) {
  const entries: Entry[] = []
  // The cloud semantics of the table below: a node's backend, the guards local, shadow mode on.
  const d = new Decider({ ...DEFAULT_BACKENDS, mode: "cloud", shadow }, { rules: { async ask() { return { answers: {}, model: "rules", latencyMs: 0 } } }, ...askers }, (e) => entries.push(e))
  return { d, entries }
}

test("each node uses its backend; G0 and local-only jobs never reach the cloud", () => {
  const { d } = decider({ cloud: failing, gliner: failing })
  assert.equal(d.backendFor("N5"), "cloud")
  assert.equal(d.backendFor("G0"), "gliner")
  assert.equal(d.backendFor("N5", true), "gliner")
  const { d: noGliner } = decider({ cloud: failing })
  assert.equal(noGliner.backendFor("G0"), "rules", "rather rules than the cloud")
  assert.equal(noGliner.backendFor("N5", true), "rules")
})

test("a decision is journaled with its state object, questions and answers", async () => {
  const { d, entries } = decider({ cloud: fixed(jevAnswers) })
  const asked = await d.ask("N5", { task: "Add a flag" }, QUESTIONS, { job: "job-1", task: "T1" })
  assert.equal(asked.backend, "cloud")
  const e = entries[0]!
  assert.equal(e.kind, "decision")
  assert.equal(e.id, asked.id)
  assert.deepEqual(e.state, { task: "Add a flag" })
  assert.equal(e.task, "T1")
})

test("a failing backend falls back to rules and says why", async () => {
  const { d, entries } = decider({ cloud: failing })
  const asked = await d.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal(asked.backend, "rules")
  assert.equal(asked.error, "down")
  assert.deepEqual(asked.decision.answers, {})
  assert.equal(entries[0]!.backend, "rules")
})

test("shadow mode journals the local backend beside the cloud one, and never runs in local mode", async () => {
  const calls: string[] = []
  const gl = fixed({ role: { type: "choice", choice: "explore", confidence: 0.7, probabilities: { code: 0.3, explore: 0.7 } } }, calls, "gliner")
  const { d, entries } = decider({ cloud: fixed(jevAnswers, calls, "cloud"), gliner: gl }, "gliner")
  await d.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal((entries[0]!.shadow as { backend: string }).backend, "gliner")
  // G0 already runs on gliner: the same backend would answer twice.
  const { d: d2, entries: e2 } = decider({ cloud: fixed(jevAnswers, calls, "cloud"), gliner: gl }, "gliner")
  await d2.ask("G0", { text: "secret" }, QUESTIONS)
  assert.equal(e2[0]!.backend, "gliner")
  assert.equal(e2[0]!.shadow, undefined, "no second backend for a guard")
  // Local mode: nothing leaves the machine, so the cloud side of a shadow is never asked.
  const cloudCalls = calls.filter((c) => c.startsWith("cloud:")).length
  const local = new Decider({ ...DEFAULT_BACKENDS, mode: "local", shadow: "cloud" }, { cloud: fixed(jevAnswers, calls, "cloud"), gliner: gl }, () => {})
  await local.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal(calls.filter((c) => c.startsWith("cloud:")).length, cloudCalls, "no cloud request in local mode")
})

test("local mode builds no cloud client and never reads a key", () => {
  let reads = 0
  const read = () => {
    reads++
    throw new Error("the keyring was read")
  }
  const local = { ...DEFAULT_BACKENDS, mode: "local" as const }
  assert.equal(cloudKey(local, read), undefined)
  assert.equal(reads, 0, "a local start touches neither JEV_API_KEY nor the keyring")
  const askers = makeAskers(local, "a-key-in-the-environment", undefined, () => false)
  assert.equal(askers.cloud, undefined, "no cloud client in local mode")
  assert.ok(askers.gliner, "the local server is the one that answers")
  const d = new Decider(local, askers, () => {})
  assert.equal(d.backendFor("N5"), "gliner", "the cloud default is demoted to the local chain")
  assert.equal(d.backendFor("G0"), "gliner")
})

test("cloud mode reads the key and builds the cloud client", () => {
  let reads = 0
  const read = () => {
    reads++
    return "k"
  }
  const cloud = { ...DEFAULT_BACKENDS, mode: "cloud" as const }
  assert.equal(cloudKey(cloud, read), "k")
  assert.equal(reads, 1)
  assert.ok(makeAskers(cloud, "k").cloud)
})

test("the cloud backend is called cloud; an old typesafe id is refused", () => {
  assert.equal(DEFAULT_BACKENDS.urls.cloud, "https://api.typesafe.ai/v1/systemone")
  assert.equal("typesafe" in DEFAULT_BACKENDS.urls, false)
  // Backends are code (DEFAULT_BACKENDS), not a config field, so an old name has nowhere to be read from: a stale
  // node override is refused rather than aliased, so the journal can never mix two names for one backend.
  const d = new Decider({ ...DEFAULT_BACKENDS, mode: "cloud", nodes: { N5: "typesafe" as unknown as BackendName } }, { cloud: fixed(jevAnswers) }, () => {})
  assert.equal(d.backendFor("N5"), "rules")
})

test("openjev is off when no server is installed, and the reason is stated", () => {
  assert.equal(makeAskers(DEFAULT_BACKENDS, undefined, undefined, () => false).openjev, undefined)
  assert.match(backendNotes(DEFAULT_BACKENDS, () => false).join("\n"), /openjev: no Open-Jev server installed/)
  assert.deepEqual(backendNotes(DEFAULT_BACKENDS, () => true), [])
  assert.ok(makeAskers(DEFAULT_BACKENDS, undefined, undefined, () => true).openjev)
})

test("the client is DecisionClient and the old names are gone", async () => {
  const mod = (await import("../packages/micromanager/src/decider.ts")) as Record<string, unknown>
  assert.equal(typeof mod.DecisionClient, "function")
  assert.equal(typeof mod.DeciderError, "function")
  assert.equal("Jev" in mod, false)
  assert.equal("JevError" in mod, false)
})

async function journalWithLabels(): Promise<Entry[]> {
  const { d, entries } = decider({ cloud: fixed(jevAnswers) })
  const a = await d.ask("N5", { task: "Add a --csv flag" }, QUESTIONS, { job: "job-1", task: "T1" })
  await d.ask("N5", { task: "Map the repo" }, QUESTIONS, { job: "job-1", task: "T2" })
  label(a.id, "role", "explore", "user_override", (e) => entries.push(e))
  return entries
}

test("Open-Jev rows: a label beats Jev's probabilities; groups decide the split", async () => {
  const rows = openJevRows(await journalWithLabels())
  assert.equal(rows.length, 4)
  const overridden = rows.find((r) => r.id && String(r.id).endsWith("/role") && r.group_id === "T1")!
  assert.deepEqual(overridden.target, [0, 1])
  assert.equal((overridden.metadata as { label_source: string }).label_source, "user_override")
  const soft = rows.find((r) => String(r.id).endsWith("/role") && r.group_id === "T2")!
  assert.deepEqual(soft.target, [0.9, 0.1])
  const noul = rows.find((r) => String(r.id).endsWith("/harmful"))!
  assert.deepEqual(noul.options, ["no", "yes"])
  assert.equal(splitOf("T1"), splitOf("T1"))
})

test("GLiNER rows carry hard labels in the oc-voice format; the state text puts the task first", async () => {
  const rows = glinerRows(await journalWithLabels())
  const first = rows[0] as { input: string; output: { classifications: { task: string; true_label: string; labels: object }[] } }
  assert.match(first.input, /^task: Add a --csv flag/)
  assert.equal(first.output.classifications[0]!.true_label, "explore")
  assert.equal(renderState({ other: 1, text: "hello" }), "text: hello\nother: 1")
})

test("the eval harness reports automatic and wrong rates per question", async () => {
  const entries = await journalWithLabels()
  const [role] = evaluate(entries, 0.8)
  assert.deepEqual({ key: role!.key, labeled: role!.labeled, automatic: role!.automatic, wrong: role!.wrong }, { key: "N5.role", labeled: 1, automatic: 1, wrong: 1 })
  assert.equal(evaluate(entries, 0.95)[0]!.automatic, 0)
})
