// A1-T4: the plan agent's profile, and the rules that let an agent read a plan. The rules are checked the way
// OpenCode applies them: every rule whose resource pattern matches, and the last match wins.
// A1-T6: the write guard's own rules, checked as the hook calls them (src/writeguard.ts).

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { agentsFrom, type AgentInfo } from "../packages/micromanager/src/agents.ts"
import { MICROMANAGER, PLAN_AGENT, type Effect, type Rule } from "../packages/micromanager/src/roles.ts"
import { installTools, type ToolDraft } from "../packages/micromanager/src/tools.ts"
import { insidePath, planRoot, realish, writeGuard } from "../packages/micromanager/src/writeguard.ts"

// "*" stands for any run of characters, as in OpenCode's own permission patterns.
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
const lastMatch = (rules: readonly Rule[], action: string, resource: string): Effect | undefined =>
  [...rules].reverse().find((r) => r.action === action && glob(r.resource).test(resource))?.effect

const PLAN = ".micromanager/plan/job-1"
const PLAN_FILE = `${PLAN}/plan.md`
const PLAN_ARTIFACT = `${PLAN}/artifacts/T1/report.svg`
const PLAN_WORKTREE_FILE = `${PLAN}/worktrees/T1/src/main.ts`

test("the plan agent writes the plan and its artifacts, and nothing else of the project", () => {
  for (const tool of ["edit", "write", "patch"]) {
    for (const path of [PLAN_FILE, PLAN_ARTIFACT, PLAN_WORKTREE_FILE]) assert.equal(lastMatch(PLAN_AGENT.rules, tool, path), "allow", `${tool} ${path}`)
    for (const path of ["src/main.ts", "README.md", ".micromanager/jobs/job-1.json", ".micromanager/notes/job-1/T1.md"]) {
      assert.equal(lastMatch(PLAN_AGENT.rules, tool, path), "deny", `${tool} ${path}`)
    }
  }
})

test("the same plan paths hold in the old state directory name and from the repository root", () => {
  const legacy = ".jev-micromanager/plan/job-1"
  for (const tool of ["edit", "write", "patch"]) {
    for (const path of [`${legacy}/plan.md`, `${legacy}/artifacts/T1/report.svg`]) assert.equal(lastMatch(PLAN_AGENT.rules, tool, path), "allow", `${tool} ${path}`)
    for (const path of [`proj/${PLAN_FILE}`, `proj/${legacy}/plan.md`]) assert.equal(lastMatch(PLAN_AGENT.rules, tool, path), "allow", `${tool} ${path}`)
    assert.equal(lastMatch(PLAN_AGENT.rules, tool, "proj/src/main.ts"), "deny", `${tool} proj/src/main.ts`)
  }
})

test("the plan's allows come after the state directory's deny, or the deny would win", () => {
  const last = (effect: Effect, action: string, resource: string) =>
    PLAN_AGENT.rules.findLastIndex((r) => r.action === action && r.resource === resource && r.effect === effect)
  assert.ok(last("allow", "edit", ".micromanager/plan*") > last("deny", "edit", ".micromanager*"))
  assert.ok(last("allow", "edit", ".micromanager/plan*") > last("deny", "edit", "*"))
})

test("build mode's micromanager reads the plan and its artifacts, and still not the jobs or notes", () => {
  for (const tool of ["read", "glob", "grep", "list"]) {
    assert.equal(lastMatch(MICROMANAGER.rules, tool, PLAN_FILE), "allow", `${tool} ${PLAN_FILE}`)
    assert.equal(lastMatch(MICROMANAGER.rules, tool, PLAN_ARTIFACT), "allow", `${tool} ${PLAN_ARTIFACT}`)
    assert.equal(lastMatch(MICROMANAGER.rules, tool, `.micromanager/jobs/job-1.json`), "deny", `${tool} jobs`)
    assert.equal(lastMatch(MICROMANAGER.rules, tool, `.micromanager/notes/job-1/T1.md`), "deny", `${tool} notes`)
  }
})

test("the plan agent reads back what it wrote, and still not the jobs or notes", () => {
  for (const tool of ["read", "glob", "grep", "list"]) {
    assert.equal(lastMatch(PLAN_AGENT.rules, tool, PLAN_FILE), "allow", `${tool} ${PLAN_FILE}`)
    assert.equal(lastMatch(PLAN_AGENT.rules, tool, PLAN_ARTIFACT), "allow", `${tool} ${PLAN_ARTIFACT}`)
    assert.equal(lastMatch(PLAN_AGENT.rules, tool, ".micromanager/jobs/job-1.json"), "deny", `${tool} jobs`)
  }
})

test("the plan agent delegates to the five roles that only read or plan, to nobody else", () => {
  for (const agent of ["explorer", "researcher", "planner", "oracle", "investigator"]) {
    assert.equal(lastMatch(PLAN_AGENT.rules, "subagent", agent), "allow", agent)
  }
  for (const agent of ["coder", "tester", "reviewer", "debugger"]) assert.equal(lastMatch(PLAN_AGENT.rules, "subagent", agent), "deny", agent)
})

test("the plan agent is refused the plugin's controls, by their real tool ids", () => {
  for (const tool of ["todo", "run_job", "merge_job", "discard_job", "rewind_job", "take_over_job", "undo_merge"]) {
    assert.equal(lastMatch(PLAN_AGENT.rules, tool, "*"), "deny", tool)
  }
  assert.equal(lastMatch(PLAN_AGENT.rules, "auto_merge", "*"), undefined, "there is no such tool")
})

test("the plan agent is a primary agent whose rules follow the base agent's", () => {
  const base: AgentInfo = {
    id: "build", name: "Build", mode: "primary", hidden: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*.env", effect: "ask" }],
  }
  const plan = agentsFrom(base).find((a) => a.id === PLAN_AGENT.agent)!
  assert.ok(plan, "agentsFrom returns the plan agent")
  assert.equal(plan.mode, "primary")
  assert.equal(plan.hidden, false)
  assert.equal(plan.name, "Micromanager (plan)")
  assert.deepEqual(plan.permissions.slice(0, base.permissions.length), base.permissions, "the user's own rules stay")
  assert.deepEqual(plan.permissions.slice(base.permissions.length), [...PLAN_AGENT.rules])
  assert.equal(plan.system, PLAN_AGENT.system)
  assert.equal(lastMatch(plan.permissions, "edit", "src/main.ts"), "deny", "the base's allow is overridden")
})

// The tool draft, as far as installTools uses it (test/tools.test.ts).
function fakeDraft() {
  const added: { id: string; execute: (args: Record<string, unknown>, ctx: object) => Promise<{ content: string }> }[] = []
  const str = { kind: "string" }
  const draft: ToolDraft = {
    get: (id) => (id === "read" ? { input: { fields: { path: str }, mapFields: (f) => ({ mapped: f() }) } } : undefined),
    add: (tool) => added.push(tool as never),
  }
  return { draft, added }
}

// A1-T6: the write guard. A plan agent or an investigator changes nothing but the plan directory, and the guard
// resolves its targets through the filesystem, so a symlink under the plan root is seen for what it points at.
const guardTmp = mkdtempSync(join(tmpdir(), "omacode-plan-guard-"))
const projectDir = join(guardTmp, "project")
const outsideDir = join(guardTmp, "outside")
const planDir = planRoot(projectDir)
mkdirSync(join(planDir, "job"), { recursive: true })
mkdirSync(outsideDir, { recursive: true })
symlinkSync(outsideDir, join(planDir, "job", "link"), "dir")
const guardScope = { root: planDir, directory: projectDir }
const guardShell = (command: string) => writeGuard({ tool: "shell", input: { command } }, guardScope)
after(() => rmSync(guardTmp, { recursive: true, force: true }))

test("realish resolves the nearest existing ancestor through a symlink, not the lexical path", () => {
  const through = join(planDir, "job", "link", "new", "file.md")
  assert.equal(realish(through), join(realish(outsideDir), "new", "file.md"))
  assert.ok(!insidePath(realish(through), realish(planDir)), "the plan path is not what it resolves to")
})

test("the guard allows a write inside the plan root and refuses one in the project", () => {
  assert.equal(writeGuard({ tool: "edit", input: { filePath: join(planDir, "plan.md") } }, guardScope).ok, true)
  const refused = writeGuard({ tool: "write", input: { path: "src/main.ts" } }, guardScope)
  assert.equal(refused.ok, false)
  assert.match(refused.ok === false ? refused.reason : "", /outside the plan root/)
  assert.match(refused.ok === false ? refused.message : "", /src\/main\.ts/)
  assert.match(refused.ok === false ? refused.message : "", /read-only in plan mode/)
})

test("a write through a symlink out of the plan root is refused, and so is a new file under it", () => {
  const linked = writeGuard({ tool: "edit", input: { path: join(planDir, "job", "link", "file.md") } }, guardScope)
  assert.equal(linked.ok, false)
  assert.match(linked.ok === false ? linked.reason : "", /outside the plan root/)
  // The file does not exist: the nearest existing ancestor is the symlink itself, and it resolves outside.
  const fresh = writeGuard({ tool: "write", input: { path: join(planDir, "job", "link", "new", "file.md") } }, guardScope)
  assert.equal(fresh.ok, false)
  assert.match(fresh.ok === false ? fresh.reason : "", /outside the plan root/)
})

test("a write that climbs out of the plan root with .. is refused", () => {
  const climbed = writeGuard({ tool: "patch", input: { path: join(planDir, "..", "..", "src", "main.ts") } }, guardScope)
  assert.equal(climbed.ok, false)
  assert.match(climbed.ok === false ? climbed.reason : "", /outside the plan root/)
})

test("a write tool whose target cannot be read is refused, not waved through", () => {
  // The patch tool carries its targets inside the patch text; this guard reads paths, so it cannot check one.
  const patch = writeGuard({ tool: "patch", input: { patchText: "*** Begin Patch\n*** Update File: src/main.ts\n" } }, guardScope)
  assert.equal(patch.ok, false)
  assert.match(patch.ok === false ? patch.reason : "", /target cannot be read/)
  assert.equal(writeGuard({ tool: "edit", input: {} }, guardScope).ok, false)
})

test("the shell guard refuses a git command that moves the refs the user's checkout shares", () => {
  for (const command of [
    "git checkout main",
    "git stash",
    "git branch -D x",
    "git worktree add ../x",
    "git config user.name x",
    "git gc",
    "git update-ref refs/heads/x HEAD",
    "true && git checkout main",
    "echo hi; git stash pop",
  ]) {
    assert.equal(guardShell(command).ok, false, command)
  }
  for (const command of ["git status", "git log --oneline -5", "git -C sub status"]) assert.equal(guardShell(command).ok, true, command)
})

test("the shell guard refuses a cd or rm that leaves the plan root, and only notes the ones inside", () => {
  for (const command of ["cd ../..", "cd /etc", "rm -rf ../../x", "rm -rf /etc/passwd"]) {
    assert.equal(guardShell(command).ok, false, command)
  }
  const rm = guardShell("rm -rf ./build")
  assert.equal(rm.ok, true)
  assert.match(rm.ok === true ? (rm.advisory ?? "") : "", /rm/)
  const cd = guardShell("cd sub && npm test")
  assert.equal(cd.ok, true)
  assert.match(cd.ok === true ? (cd.advisory ?? "") : "", /cd sub/)
})

test("the shell guard refuses an absolute path outside the plan root and allows the streams", () => {
  const passwd = guardShell("cat /etc/passwd")
  assert.equal(passwd.ok, false)
  assert.match(passwd.ok === false ? passwd.reason : "", /absolute path/)
  assert.equal(guardShell("ls > /dev/null").ok, true)
  assert.equal(guardShell("npm test 2>/dev/null").ok, true)
})

test("the shell guard allows an absolute path under the session's own directory", () => {
  // The investigator's session directory is its plan worktree, which lies inside the plan root; the plan agent's is
  // the project, and the project stays readable by absolute path even though it is not writable.
  assert.equal(guardShell(`cat ${join(projectDir, "README.md")}`).ok, true)
})

test("the plugin's tools refuse the plan agent: only the micromanager may use them", async () => {
  const { draft, added } = fakeDraft()
  const ok = async () => "ok"
  const handlers = { tasks: ok, plan: ok, questions: ok, run: ok, status: ok, stop: ok, steer: ok, stopTask: ok, merge: ok, discard: ok, access: ok, permission: ok, rewind: ok, undoMerge: ok, takeOver: ok, todo: ok, contract: ok, backlog: ok, decideChange: ok, contractRound: ok, evolve: ok }
  installTools(draft, handlers)
  const tool = added.find((t) => t.id === "list_tasks")!
  assert.deepEqual(await tool.execute({ id: "T1" }, { agent: PLAN_AGENT.agent }), { content: "Only the micromanager agent may use this tool." })
  assert.deepEqual(await tool.execute({ id: "T1" }, { agent: MICROMANAGER.agent }), { content: "ok" })
})
