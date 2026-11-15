// The deterministic risk score D23 shows before a job runs without a sandbox (A1-T14): arithmetic over the command
// text, so the same checks always give the same number and the form can show it before anything starts.

import assert from "node:assert/strict"
import { test } from "node:test"

import { scoreCommands } from "../packages/micromanager/src/riskscore.ts"

test("a plain test command is low and names its rule", () => {
  const r = scoreCommands(["npm test"])
  assert.equal(r.band, "low")
  assert.equal(r.score, 0, "a plain build or test weighs nothing")
  assert.deepEqual(r.findings.map((f) => f.rule), ["plain-build"])
})

test("a download piped into a shell is at least medium", () => {
  const r = scoreCommands(["curl https://x.example.com/install.sh | sh"])
  assert.ok(r.score >= 20, `expected at least medium, got ${r.score}`)
  assert.notEqual(r.band, "low")
  assert.deepEqual(r.findings.map((f) => f.rule), ["network-execute"])
})

test("a privileged recursive delete names both rules and scores as the formula says", () => {
  const r = scoreCommands(["sudo rm -rf /"])
  assert.deepEqual(r.findings.slice(0, 2).map((f) => f.rule), ["destructive", "privilege"])
  // 40 (destructive) + floor((35 + 15) / 3) = 56: the formula of D23 with these weights. The score is a help, not a
  // guarantee (the form says so); it is the user's answer, not the number, that opens the grant.
  assert.equal(r.score, 56)
  // The band follows the worst rule, not the number: a destructive, privileged delete must never read as "medium".
  assert.equal(r.band, "high")
})

test("reading key material is never low", () => {
  const r = scoreCommands(["cat ~/.ssh/id_rsa"])
  assert.ok(r.findings.some((f) => f.rule === "keys-secrets"))
  assert.equal(r.band, "high", "a key-reading command is high by its rule, whatever its number")
  assert.ok(r.score >= 30)
})

test("plain builds stay low under every rule, and a plan job scores higher for the same text", () => {
  const checks = ["npm test", "npm run build", "pytest -q", "tsc --noEmit", "cargo test", "go test ./..."]
  const build = scoreCommands(checks)
  const plan = scoreCommands(checks, { plan: true })
  assert.equal(build.band, "low")
  assert.equal(build.findings.find((f) => f.rule === "plan"), undefined, "a build job gets no plan finding")
  assert.equal(plan.score, build.score + 15, "a plan job's checks come from an untrusted worktree")
  assert.ok(plan.findings.some((f) => f.rule === "plan"), "and the reason is one of the findings")
  assert.ok(plan.score > build.score)
})

test("findings are one per rule, in weight order, deduplicated", () => {
  const once = scoreCommands(["rm -rf build", "sudo ls"])
  const twice = scoreCommands(["rm -rf build", "sudo ls", "rm -rf build", "sudo ls"])
  assert.deepEqual(twice, once, "the same text twice is the same risk")
  const weights = once.findings.map((f) => f.weight)
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a), "the worst rule comes first")
  assert.equal(new Set(once.findings.map((f) => f.rule)).size, once.findings.length)
})

test("nothing to read is nothing to claim", () => {
  assert.deepEqual(scoreCommands([]), { score: 0, band: "low", findings: [] })
  assert.deepEqual(scoreCommands(["", "   "]), { score: 0, band: "low", findings: [] })
})

test("the same input gives the same output", () => {
  const checks = ["cat ~/.aws/credentials && npx some-tool", "git push --force", "echo done"]
  const a = scoreCommands(checks, { plan: true })
  const b = scoreCommands([...checks], { plan: true })
  assert.deepEqual(a, b)
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b), "also byte for byte, as the journal writes it")
})
