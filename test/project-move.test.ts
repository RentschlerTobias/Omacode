// A project folder that is renamed, moved or copied keeps working: its memory, its jobs and their git worktrees. Real
// git and real renames, since the defect was git's absolute links and keys made from the folder's path.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { LEGACY_PROJECT_STATE as LEGACY, PROJECT_STATE as STATE } from "../packages/core/src/paths.ts"
import { pathSlug, projectId, projectRoot, PROJECT_FILE } from "../packages/core/src/project.ts"
import { Memory } from "../packages/context/src/memory.ts"
import { loadJob, relocateJob, saveJob } from "../packages/state/src/store.ts"
import { prepareIntegration, prepareTaskWorktree, validateIntegration, changedFiles } from "../packages/micromanager/src/integration.ts"
import type { Job } from "../packages/micromanager/src/state.ts"

const ROOT = tempDir("mm-move-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

function repo(name: string): string {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "t@example.com")
  git(dir, "config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "a\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return dir
}

test("a worktree or plan area belongs to the project that holds it", () => {
  assert.equal(projectRoot(`/p/x/${STATE}/worktrees/job-1--T1/sub`), "/p/x")
  assert.equal(projectRoot(`/p/x/${LEGACY}/plan/job-1/T1`), "/p/x")
  assert.equal(projectRoot("/p/x"), "/p/x")
})

test("a project's id is its old path slug, kept in its state directory, and survives a rename", () => {
  const dir = repo("id-a")
  const before = pathSlug(dir)
  assert.equal(projectId(dir), before)
  assert.equal(existsSync(join(dir, STATE, PROJECT_FILE)), false, "looking does not create the file")
  assert.equal(projectId(dir, { create: true }), before)
  assert.match(git(dir, "status", "--porcelain"), /^$/, "the id file stays out of git")
  const moved = join(ROOT, "id-b")
  renameSync(dir, moved)
  assert.equal(projectId(moved), before)
  assert.equal(projectId(join(moved, STATE, "worktrees", "job-1")), before)
})

test("the memory of a renamed project is still its own, and a worktree session sees it", async () => {
  const dir = repo("mem-a")
  const memory = new Memory(undefined, () => {}, { root: join(ROOT, "memory-root"), embed: false, git: false })
  const store = memory.store()!
  store.add({ scope: "project", project: memory.slug(dir, true)!, text: "Run the tests with npm test.", pinned: true })
  const moved = join(ROOT, "mem-b")
  renameSync(dir, moved)
  assert.match(memory.core(moved), /npm test/)
  assert.match(memory.core(join(moved, STATE, "worktrees", "job-1--T1")), /npm test/)
})

test("a project that already has memory under its path slug gets its id before it is moved", () => {
  const dir = repo("old-a")
  const memory = new Memory(undefined, () => {}, { root: join(ROOT, "memory-old"), embed: false, git: false })
  memory.store()!.add({ scope: "project", project: pathSlug(dir), text: "Old fact.", pinned: true })
  memory.core(dir) // a read is enough
  assert.equal(existsSync(join(dir, STATE, PROJECT_FILE)), true)
  renameSync(dir, join(ROOT, "old-b"))
  assert.match(memory.core(join(ROOT, "old-b")), /Old fact/)
})

test("a job of a renamed project finds its worktrees again, and git knows them", async () => {
  const dir = repo("job-a")
  const integration = await prepareIntegration(dir, "job-1")
  const task = await prepareTaskWorktree(dir, "job-1", "T1", integration.branch)
  writeFileSync(join(task.worktree, "b.txt"), "b\n")
  const job = { id: "job-1", created: "x", integrationBranch: integration.branch, integrationWorktree: integration.worktree, goal: `keep ${dir}/${STATE}/x as text`, tasks: [{ id: "T1", worktree: task.worktree, branch: task.branch, status: "running" }] } as unknown as Job
  saveJob(dir, job)

  const moved = join(ROOT, "job-b")
  renameSync(dir, moved)
  const loaded = loadJob(moved, "job-1")!
  assert.equal(loaded.integrationWorktree, join(moved, STATE, "worktrees", "job-1"))
  assert.equal(loaded.tasks[0]!.worktree, join(moved, STATE, "worktrees", "job-1--T1"))
  assert.equal(loaded.goal, job.goal, "a path inside a text is left alone")
  assert.deepEqual(await validateIntegration(loaded, undefined, moved), { ok: true })
  assert.deepEqual(await changedFiles(loaded.tasks[0]!.worktree!), ["b.txt"])
  assert.doesNotMatch(git(moved, "worktree", "list", "--porcelain"), /prunable/)
  assert.match(readFileSync(join(moved, STATE, "jobs", "job-1.json"), "utf8"), new RegExp(`job-b/\\${STATE}/worktrees/job-1"`), "the rewrite is saved")
})

test("a copied project's job points at the copy's worktrees, not the original's", () => {
  const dir = repo("copy-a")
  const job = { id: "job-2", integrationWorktree: join(dir, STATE, "worktrees", "job-2"), tasks: [] } as unknown as Job
  mkdirSync(job.integrationWorktree!, { recursive: true })
  const copy = join(ROOT, "copy-b")
  cpSync(dir, copy, { recursive: true })
  assert.deepEqual(relocateJob(job, copy), [join(copy, STATE, "worktrees", "job-2")])
  assert.equal(job.integrationWorktree, join(copy, STATE, "worktrees", "job-2"))
})

test("memory-adopt proposes keys of the same folder name and of the project's job worktrees, and moves them", async () => {
  const { adopt, adoptCandidates } = await import("../packages/context/src/adopt.ts")
  const { MemoryStore } = await import("../packages/context/src/store.ts")
  const dir = repo("adopt-me")
  mkdirSync(join(dir, STATE, "jobs"), { recursive: true })
  writeFileSync(join(dir, STATE, "jobs", "job-7.json"), "{}")
  const store = new MemoryStore(join(ROOT, "memory-adopt"), { git: false })
  store.add({ scope: "project", project: "adopt-me-aaaaaa", text: "From before the rename.", pinned: false })
  store.add({ scope: "project", project: "job-7-t1-bbbbbb", text: "A worker's fact.", pinned: false })
  store.add({ scope: "project", project: "other-cccccc", text: "Someone else's.", pinned: false })
  const { id, candidates } = adoptCandidates(store, dir)
  assert.deepEqual(candidates.map((c) => [c.slug, c.why]).sort(), [["adopt-me-aaaaaa", "same folder name"], ["job-7-t1-bbbbbb", "worktree of this project's job"]])
  assert.deepEqual(adopt(store, dir, candidates.map((c) => c.slug)), { id, moved: 2 })
  assert.deepEqual(store.list({ project: id }).filter((e) => e.scope === "project").map((e) => e.text).sort(), ["A worker's fact.", "From before the rename."])
  assert.equal(store.hasProject("other-cccccc"), true, "a key that is not proposed stays where it is")
  assert.equal(existsSync(join(dir, STATE, PROJECT_FILE)), true)
})
