// A2b-T1/T2/T6: what the local model is trained on and what labels it learns from. The export must cover the guards
// AND the permission node (`answer`, `needs_user`, `risk`, `path_relevance`) and every non-guard node the local model
// is expected to answer; a user's label beats an outcome, and an outcome beats a cloud answer.

import assert from "node:assert/strict"
import { test } from "node:test"

import { GUARDS } from "../packages/micromanager/src/catalog.ts"
import { PERMISSION_NODE, PERMISSION_QUESTIONS, RELEVANCE_QUESTION } from "../packages/micromanager/src/decide.ts"
import { glinerRows, labelPermission, labeled, localQuestions, LOCAL_NODES, openJevRows, permissionTarget, target } from "../packages/micromanager/src/dataset.ts"
import type { Question } from "../packages/micromanager/src/decider.ts"
import { readJournal, record, type Entry } from "../packages/micromanager/src/journal.ts"
import { tempDir } from "./harness.ts"

const QUESTIONS: Record<string, Question> = {
  answer: { type: "choice", instructions: "Should this request be allowed?", criteria: { allow: "safe and fitting", deny: "unsafe" } },
  harmful: { type: "noul", instructions: "This asks for help to hurt people." },
}

function decisionEntry(node: string, questions: Record<string, Question>, extra: Record<string, unknown> = {}): Entry {
  return {
    kind: "decision",
    id: `${node}-1`,
    node,
    backend: "cloud",
    state: { task: `a ${node} state` },
    questions,
    answers: { ...Object.fromEntries(Object.entries(questions).map(([qid, q]) => [qid, q.type === "choice" ? { type: "choice", choice: "allow", confidence: 0.6, probabilities: { allow: 0.6, deny: 0.4 } } : q.type === "noul" ? { type: "noul", noul: 0.4 } : { type: "score", score: 0, confidence: 0.6, probabilities: { "0": 0.6, "1": 0.4 } }])) },
    ...extra,
  }
}

test("the export covers the guards and every non-guard node the local model must answer", () => {
  const entries: Entry[] = LOCAL_NODES.map((node) => {
    const questions = localQuestions(node) ?? QUESTIONS
    return decisionEntry(node, questions)
  })
  const rows = glinerRows(entries)
  const nodes = new Set(rows.map((r) => String(r.node)))
  for (const node of LOCAL_NODES) assert.ok(nodes.has(node), `${node} is in the export`)
  // The guards are the three statements, each a yes/no task with its own task id.
  const guardRows = rows.filter((r) => r.node === "G0") as { output: { classifications: { task: string; labels: object; true_label: string }[] } }[]
  assert.deepEqual(guardRows.map((r) => r.output.classifications[0]!.task).sort(), Object.keys(GUARDS).sort())
  assert.deepEqual(Object.keys(guardRows[0]!.output.classifications[0]!.labels), ["yes", "no"])
})

test("permission questions and path_relevance are exported with the labels the server asks for", () => {
  const questions = { ...PERMISSION_QUESTIONS, path_relevance: RELEVANCE_QUESTION }
  const entry = decisionEntry(PERMISSION_NODE, questions)
  // A user says: deny it. And the paths were judged to matter (level 2).
  const labels: Entry[] = [
    { kind: "label", decision: "N13-1", question: "answer", value: "deny", source: "user" },
    { kind: "label", decision: "N13-1", question: "path_relevance", value: 2, source: "user" },
  ]
  const rows = glinerRows([entry, ...labels])
  const answer = rows.find((r) => (r.output as { classifications: { task: string }[] }).classifications[0]!.task === "answer") as { node: string; output: { classifications: { labels: Record<string, string>; true_label: string }[] } }
  assert.equal(answer.node, PERMISSION_NODE)
  assert.deepEqual(Object.keys(answer.output.classifications[0]!.labels), ["allow", "deny"])
  assert.equal(answer.output.classifications[0]!.true_label, "deny")
  // A score question is exported with numbered levels, the wire format the server answers in.
  const relevance = rows.find((r) => (r.output as { classifications: { task: string }[] }).classifications[0]!.task === "path_relevance") as { output: { classifications: { labels: Record<string, string>; true_label: string }[] } }
  assert.deepEqual(Object.keys(relevance.output.classifications[0]!.labels), ["0", "1", "2"])
  assert.equal(relevance.output.classifications[0]!.true_label, "2")
})

test("a user label beats an outcome, and an outcome beats the cloud answer", () => {
  const entry = decisionEntry("N13", PERMISSION_QUESTIONS)
  const outcome: Entry = { kind: "label", decision: "N13-1", question: "answer", value: "deny", source: "outcome" }
  const user: Entry = { kind: "label", decision: "N13-1", question: "answer", value: "allow", source: "user" }
  const withUser = labeled([entry, outcome, user]).find((r) => r.qid === "answer")!
  assert.deepEqual(withUser.label, { value: "allow", source: "user" }, "the user's word wins, even though the outcome came later")
  assert.deepEqual(target(withUser)?.probs, [1, 0])
  const onlyOutcome = labeled([entry, outcome]).find((r) => r.qid === "answer")!
  assert.deepEqual(onlyOutcome.label, { value: "deny", source: "outcome" })
  assert.deepEqual(target(onlyOutcome)?.source, "outcome")
  // Without a label, the cloud answer is the soft target.
  const cloud = labeled([entry]).find((r) => r.qid === "answer")!
  assert.deepEqual(target(cloud)?.probs, [0.6, 0.4])
})

test("permission outcomes map to the answer they say was right", () => {
  assert.equal(permissionTarget("allowed-and-succeeded", "allow"), "allow")
  assert.equal(permissionTarget("denied-and-retried", "deny"), "deny")
  assert.equal(permissionTarget("user-overrode", "allow"), "deny")
  assert.equal(permissionTarget("user-overrode", "deny"), "allow")
  // Open-Jev rows read the same label.
  const entry = decisionEntry("N13", PERMISSION_QUESTIONS)
  const rows = openJevRows([entry, { kind: "label", decision: "N13-1", question: "answer", value: "deny", source: "outcome" }])
  const answer = rows.find((r) => String(r.id).endsWith("/answer"))!
  assert.deepEqual(answer.target, [0, 1])
  assert.equal((answer.metadata as { label_source: string }).label_source, "outcome")
})

test("a permission outcome survives a journal round-trip", () => {
  const path = `${tempDir("mm-journal-")}/decisions.jsonl`
  const entry = decisionEntry("N13", PERMISSION_QUESTIONS)
  record(entry, path)
  labelPermission("N13-1", "allowed-and-succeeded", "allow", (e) => record(e, path))
  const back = readJournal(path)
  assert.equal(back.length, 2)
  const row = labeled(back).find((r) => r.qid === "answer")!
  assert.deepEqual(row.label, { value: "allow", source: "outcome" })
  assert.deepEqual(target(row)?.probs, [1, 0])
})
