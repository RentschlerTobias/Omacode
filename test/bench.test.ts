// A2b-T4/T5/T6: the numeric gate, per-node floor application, and the two ways it refuses to be talked into passing
// (a changed threshold or a changed wording without a corpus bump). The fixtures here are unit-sized; the real numbers
// come from `npm run bench` and live in bench/A2B.md.

import assert from "node:assert/strict"
import { test } from "node:test"

import { buildReport, calibratePermissions, checkCorpus, CORPUS_VERSION, floorsFor, GATE_THRESHOLDS, jobStartDecisionLine, loadGuardCorpus, loadPermissionCorpus, permissionScores, QUESTIONS_FINGERPRINT, askRate, type BenchReport, type PermissionSeen } from "../packages/micromanager/src/bench.ts"
import { DEFAULT_FLOORS, type PermissionRequest } from "../packages/micromanager/src/decide.ts"
import type { Decision } from "../packages/micromanager/src/decider.ts"
import { LOCAL_NODES } from "../packages/micromanager/src/dataset.ts"
import type { Entry } from "../packages/micromanager/src/journal.ts"

const request = (action: string): PermissionRequest => ({ sessionID: "bench", agent: "coder", action, resources: [`a ${action} request`], directory: "/bench" })

const answer = (choice: "allow" | "deny", confidence: number, needsUser = 0.1, risk = 0.4): Decision => ({
  answers: {
    answer: { type: "choice", choice, confidence, probabilities: { allow: choice === "allow" ? confidence : 1 - confidence, deny: choice === "deny" ? confidence : 1 - confidence } },
    needs_user: { type: "noul", noul: needsUser },
    risk: { type: "score", score: risk, confidence: 0.8, probabilities: {} },
  },
  model: "bench",
  latencyMs: 1,
})

const seen = (expect: PermissionSeen["expect"], action: string, choice: "allow" | "deny", confidence = 0.95, needsUser = 0.1): PermissionSeen => ({
  expect,
  case: { text: `a ${action} request`, action, expect },
  request: request(action),
  decision: answer(choice, confidence, needsUser),
  answered: true,
})

// A corpus the model gets right at a high confidence: no wrong allow, nothing asked.
const good = (): PermissionSeen[] => [
  ...Array.from({ length: 10 }, (_, i) => seen("allow", i % 2 ? "shell" : "edit", "allow")),
  ...Array.from({ length: 2 }, () => seen("deny", "shell", "deny")),
  ...Array.from({ length: 2 }, (_, i) => seen("user", i ? "shell" : "read", "deny", 0.5)),
]

const passingReport = (permission: readonly PermissionSeen[] = good()): BenchReport => buildReport({ guardCases: 16, guardRows: [], permission })

test("a bench fixture that can pass: the permission node gets measured floors of its own", () => {
  const cal = calibratePermissions(good())
  assert.equal(cal.pass, true, cal.why)
  assert.equal(cal.floors.read, 0.5, "the lowest pair the false-allow cap allows is the measurement")
  const report = passingReport()
  const choice = floorsFor("N13", "calibrated", report)
  assert.equal(choice.source, "calibrated")
  assert.deepEqual(choice.floors, cal.floors)
  assert.match(choice.why, /N13 passed/)
})

test("a bench fixture that must fail: one confident wrong allow sinks the node", () => {
  const bad = [...good().slice(0, -1), seen("deny", "shell", "allow")]
  const cal = calibratePermissions(bad)
  assert.equal(cal.pass, false, "a wrong allow is the expensive error and may not be traded for fewer questions")
  assert.ok(cal.scores.falseAllow > GATE_THRESHOLDS.permission.falseAllow)
  const choice = floorsFor("N13", "calibrated", passingReport(bad))
  assert.equal(choice.source, "default")
  assert.deepEqual(choice.floors, DEFAULT_FLOORS)
  assert.match(choice.why, /did not pass/)
})

test("a fixture that asks too much fails on the ask-rate, even with no wrong allow", () => {
  const unsure = good().map((s) => ({ ...s, decision: answer(s.decision.answers.answer?.type === "choice" && s.decision.answers.answer.choice === "deny" ? "deny" : "allow", 0.45) }))
  const cal = calibratePermissions(unsure)
  assert.equal(cal.pass, false)
  assert.match(cal.why, /ask/)
  assert.equal(cal.scores.falseAllow, 0)
})

test("default floors apply to every node until the gate says otherwise", () => {
  const report = passingReport()
  for (const node of LOCAL_NODES) {
    const choice = floorsFor(node, "default", report)
    assert.equal(choice.source, "default", node)
    assert.deepEqual(choice.floors, DEFAULT_FLOORS)
  }
  // The overall gate did not pass (the guard corpus is far too small), and every unmeasured node stays default.
  assert.equal(report.pass, false)
  assert.equal(floorsFor("N1", "calibrated", report).source, "default")
  assert.match(floorsFor("N1", "calibrated", report).why, /did not pass/)
})

test("no bench at all leaves every node on the default floors, and says so", () => {
  const choice = floorsFor("N13", "calibrated", undefined)
  assert.equal(choice.source, "default")
  assert.match(choice.why, /no bench/)
  assert.deepEqual(choice.floors, DEFAULT_FLOORS)
})

test("the gate refuses a report whose corpus, wordings or thresholds moved without a re-measure", () => {
  const report = passingReport()
  const moved = { ...report, corpus: CORPUS_VERSION + 1 }
  assert.match(floorsFor("N13", "calibrated", moved).why, /corpus/)
  assert.equal(floorsFor("N13", "calibrated", moved).source, "default")
  const reworded = { ...report, questions: "0000000000000000" }
  assert.match(floorsFor("N13", "calibrated", reworded).why, /wordings changed/)
  const releveled = { ...report, thresholds: { ...report.thresholds, permission: { ...report.thresholds.permission, askRate: 0.31 } } }
  assert.match(floorsFor("N13", "calibrated", releveled).why, /thresholds changed/)
  assert.equal(floorsFor("N13", "calibrated", releveled).source, "default")
})

test("a corpus written for other wordings is refused before a number is produced", () => {
  assert.throws(() => checkCorpus({ version: CORPUS_VERSION + 1, questions: QUESTIONS_FINGERPRINT }, "bench/x.json"), /version/)
  assert.throws(() => checkCorpus({ version: CORPUS_VERSION, questions: "old" }, "bench/x.json"), /wordings changed/)
  checkCorpus({ version: CORPUS_VERSION, questions: QUESTIONS_FINGERPRINT }, "bench/x.json")
})

test("the pinned corpora on disk still match this build", () => {
  assert.equal(loadGuardCorpus("bench/guard_cases.json").length, 13)
  assert.equal(loadPermissionCorpus("bench/permission_cases.json").length, 27)
})

test("permission scores count what the user pays for: wrong allows and questions", () => {
  const scores = permissionScores(good(), DEFAULT_FLOORS)
  assert.equal(scores.cases, 14)
  assert.equal(scores.falseAllow, 0)
  assert.equal(scores.askRate, 0.125, "only the shell case that is the user's call at 0.5 confidence is asked")
})

test("the job-start line reports the ask-rate over N jobs and the nodes still on default floors", () => {
  const entries: Entry[] = [
    { kind: "permission", action: "shell", job: "job-1", verdict: "user" },
    { kind: "permission", action: "shell", job: "job-1", verdict: "allow" },
    { kind: "permission", action: "shell", job: "job-2", verdict: "allow" },
    { kind: "permission", action: "read", job: "job-2", verdict: "user" }, // not a shell decision
    { kind: "permission", action: "shell", job: "job-3", verdict: "user" },
    { kind: "permission", action: "shell", job: "job-3", verdict: "allow" },
  ]
  const rate = askRate(entries, 2)
  assert.equal(rate.shell, 3, "the two newest jobs only")
  assert.equal(rate.scope, "the last 2 jobs")
  assert.equal(rate.rate, 1 / 3)
  const line = jobStartDecisionLine({ entries, mode: "default", report: passingReport(), floors: DEFAULT_FLOORS, jobs: 2 })
  assert.match(line, /ask-rate: 33% of shell decisions reached the user \(1\/3, the last 2 jobs\)/)
  assert.match(line, /floors: default/)
  assert.ok(line.includes(`on the default floors: all ${LOCAL_NODES.length} nodes`))
  // Calibrated for N13 only: it disappears from the default list, the rest stay.
  const calibrated = jobStartDecisionLine({ entries, mode: "calibrated", report: passingReport(), floors: DEFAULT_FLOORS, jobs: 2 })
  assert.match(calibrated, /calibrated for 1 of 15/)
  assert.match(calibrated, /on the default floors: G0, G0\.injection, G, N1/)
  assert.ok(!calibrated.includes("N13,"))
})

test("decider.floors is a config value, and its default is the conservative state", async () => {
  const { parseFloorsMode } = await import("../packages/micromanager/src/config.ts")
  assert.equal(parseFloorsMode("{}"), "default")
  assert.equal(parseFloorsMode('{"decider": {"mode": "local"}}'), "default")
  assert.equal(parseFloorsMode('{"decider": {"floors": "calibrated"}}'), "calibrated")
  assert.throws(() => parseFloorsMode('{"decider": {"floors": "always"}}'), /"default" or "calibrated"/)
})

test("a guard node that passes the numbers leaves the default list without changing its floor", () => {
  // 300 cases, ten injections, all ten found, none falsely: the guard clause is satisfiable.
  const rows = Array.from({ length: 300 }, (_, i) => ({ yes: i < 10 ? ["injection"] : [], p: { injection: i < 10 ? 0.9 : 0.1, sensitive: 0.1 } }))
  const report = buildReport({ guardCases: 300, guardRows: rows, permission: good() })
  assert.equal(report.nodes.find((n) => n.node === "G0")!.pass, true)
  const choice = floorsFor("G0", "calibrated", report)
  assert.equal(choice.source, "calibrated")
  assert.deepEqual(choice.floors, DEFAULT_FLOORS, "a guard node's measurement is precision/recall, not a new pair")
  assert.match(choice.why, /guard floor stays 0\.5/)
  // The overall report still fails: the ten non-guard nodes have no cases.
  assert.equal(report.pass, false)
})
