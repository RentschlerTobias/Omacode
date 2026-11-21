// A5: an old state directory moves to the current one with its jobs and git worktrees intact. Real git, real
// directories: what can break is git's links and the paths the jobs keep.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { LEGACY_PROJECT_STATES, PROJECT_STATE, stateDir } from "../packages/core/src/paths.ts"
import { applyMigration, planMigration } from "../packages/state/src/migrate.ts"
import { loadJob, saveJob } from "../packages/state/src/store.ts"
import { changedFiles, prepareIntegration, prepareTaskWorktree, validateIntegration } from "../packages/micromanager/src/integration.ts"
import type { Job } from "../packages/micromanager/src/state.ts"

const [OLD, OLDEST] = LEGACY_PROJECT_STATES
const ROOT = tempDir("mm-migrate-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

// A project from before the move: its state under an old name, a job with an integration and a task worktree.
async function legacyProject(name: string, dir: string = OLD, status = "merged"): Promise<string> {
  const project = join(ROOT, name)
  mkdirSync(join(project, dir), { recursive: true })
  git(project, "init", "-q")
  git(project, "config", "user.email", "t@example.com")
  git(project, "config", "user.name", "t")
  writeFileSync(join(project, "a.txt"), "a\n")
  git(project, "add", "a.txt")
  git(project, "commit", "-qm", "init")
  assert.equal(stateDir(project), dir)
  const integration = await prepareIntegration(project, "job-1")
  const task = await prepareTaskWorktree(project, "job-1", "T1", integration.branch)
  writeFileSync(join(task.worktree, "b.txt"), "b\n")
  saveJob(project, { id: "job-1", created: "x", integrationBranch: integration.branch, integrationWorktree: integration.worktree, tasks: [{ id: "T1", status, worktree: task.worktree, branch: task.branch }] } as unknown as Job)
  return project
}

test("a dry run says what moves and moves nothing", async () => {
  const project = await legacyProject("dry")
  const plan = planMigration(project)
  assert.equal(plan.from, OLD)
  assert.equal(plan.to, PROJECT_STATE)
  assert.equal(plan.jobs, 1)
  assert.equal(plan.worktrees.length, 2)
  assert.deepEqual(plan.problems, [])
  assert.equal(existsSync(join(project, OLD)), true)
  assert.equal(existsSync(join(project, PROJECT_STATE)), false)
})

test("apply moves the state directory, and the job's worktrees work at their new place", async () => {
  const project = await legacyProject("apply")
  const result = applyMigration(planMigration(project))
  assert.equal(result.moved, true, result.text)
  assert.equal(existsSync(join(project, OLD)), false)
  assert.equal(stateDir(project), PROJECT_STATE)
  const job = loadJob(project, "job-1")!
  assert.equal(job.integrationWorktree, join(project, PROJECT_STATE, "worktrees", "job-1"))
  assert.deepEqual(await validateIntegration(job, undefined, project), { ok: true })
  assert.deepEqual(await changedFiles(job.tasks[0]!.worktree!), ["b.txt"])
  assert.doesNotMatch(git(project, "worktree", "list", "--porcelain"), /prunable/)
  assert.ok(readFileSync(join(project, ".git", "info", "exclude"), "utf8").split("\n").includes(`**/${PROJECT_STATE}/*`))
  assert.equal(git(project, "status", "--porcelain"), "", "nothing of the state shows in git status")
  assert.equal(planMigration(project).from, undefined, "a second run has nothing to move")
})

test("the oldest name migrates too, and a project moved before its migration is relinked", async () => {
  const project = await legacyProject("oldest-a", OLDEST)
  const moved = join(ROOT, "oldest-b")
  renameSync(project, moved)
  const result = applyMigration(planMigration(moved))
  assert.equal(result.moved, true, result.text)
  const job = loadJob(moved, "job-1")!
  assert.deepEqual(await validateIntegration(job, undefined, moved), { ok: true })
  assert.doesNotMatch(git(moved, "worktree", "list", "--porcelain"), /prunable/)
})

test("a job at work, or state in two places, stops the move", async () => {
  const busy = await legacyProject("busy", OLD, "running")
  const plan = planMigration(busy)
  assert.match(plan.problems.join(), /job-1 still has a task at work/)
  assert.equal(applyMigration(plan).moved, false)
  assert.equal(existsSync(join(busy, OLD)), true)

  const both = await legacyProject("both")
  mkdirSync(join(both, PROJECT_STATE), { recursive: true })
  assert.match(planMigration(both).problems.join(), /exists already/)
  const two = await legacyProject("two")
  mkdirSync(join(two, OLDEST))
  assert.match(planMigration(two).problems.join(), /both/)
})

test("a project without state, or already on the current name, has nothing to move", () => {
  const fresh = join(ROOT, "fresh")
  mkdirSync(fresh)
  assert.equal(planMigration(fresh).from, undefined)
  assert.deepEqual(applyMigration(planMigration(fresh)).moved, false)
})

test("the user's directories and settings keep their old names until migrate --user moves them", async () => {
  const { configFilePath, picksFilePath, userDataDir, userStateDir } = await import("../packages/core/src/paths.ts")
  const { applyUserMigration, planUserMigration } = await import("../packages/state/src/migrate.ts")
  const home = join(ROOT, "home")
  const saved = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME }
  process.env.XDG_STATE_HOME = join(home, "state")
  process.env.XDG_DATA_HOME = join(home, "share")
  process.env.XDG_CONFIG_HOME = join(home, "config")
  try {
    // A fresh user gets the current names.
    assert.equal(userStateDir(), join(home, "state", "omacode"))
    assert.equal(configFilePath(), join(home, "config", "opencode", "omacode.jsonc"))
    assert.deepEqual(planUserMigration().moves, [])
    // A user from before keeps the old ones.
    for (const dir of [join(home, "state", "micromanager"), join(home, "share", "micromanager", "memory"), join(home, "config", "opencode")]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(home, "state", "micromanager", "decisions.jsonl"), "{}\n")
    writeFileSync(join(home, "config", "opencode", "micromanager.jsonc"), "{ \"budget\": {} }\n")
    writeFileSync(join(home, "config", "opencode", "micromanager-models.json"), "{}\n")
    assert.equal(userStateDir(), join(home, "state", "micromanager"))
    assert.equal(userDataDir(), join(home, "share", "micromanager"))
    assert.equal(configFilePath(), join(home, "config", "opencode", "micromanager.jsonc"))
    assert.equal(picksFilePath(), join(home, "config", "opencode", "micromanager-models.json"))
    const plan = planUserMigration()
    assert.equal(plan.moves.length, 4)
    assert.deepEqual(plan.problems, [])
    assert.equal(applyUserMigration(plan).moved, 4)
    assert.equal(userStateDir(), join(home, "state", "omacode"))
    assert.equal(readFileSync(join(userStateDir(), "decisions.jsonl"), "utf8"), "{}\n")
    assert.equal(existsSync(join(userDataDir(), "memory")), true)
    assert.equal(configFilePath(), join(home, "config", "opencode", "omacode.jsonc"))
    assert.equal(picksFilePath(), join(home, "config", "opencode", "omacode-models.json"))
    // Both names at once: nothing is merged.
    mkdirSync(join(home, "state", "micromanager"))
    assert.match(planUserMigration().problems.join(), /both .* exist/)
  } finally {
    for (const [key, value] of [["XDG_STATE_HOME", saved.state], ["XDG_DATA_HOME", saved.data], ["XDG_CONFIG_HOME", saved.config]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
