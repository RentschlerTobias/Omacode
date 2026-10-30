// The auto-merge path (src/automerge.ts maybeAutoMerge, on src/integration.ts mergeIntoCheckout) is exercised here
// with real git repositories, not a fake Exec: the point is what git itself is willing to fast-forward, rebase and
// refuse in a user's checkout. The user's own config and state are never touched: the whole file runs with
// XDG_CONFIG_HOME and XDG_STATE_HOME pointed at temporary directories, so loadSettings reads an empty config
// (autoMerge's default, true) unless a test writes one, and nothing a hook records lands in a real journal.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"

import { maybeAutoMerge, type AutoMergeOutcome } from "../src/automerge.ts"
import { undoMerge } from "../src/plugin.ts"
import { DIR, excludeFromGit, loadJob, saveJob } from "../src/store.ts"
import type { Job, Task } from "../src/state.ts"

// --- the user's machine is off limits for the whole file ------------------------------------------------------

const CONFIG = mkdtempSync(join(tmpdir(), "micromanager-automerge-cfg-"))
const STATE = mkdtempSync(join(tmpdir(), "micromanager-automerge-state-"))
const savedEnv = {
  config: process.env.XDG_CONFIG_HOME,
  state: process.env.XDG_STATE_HOME,
}
process.env.XDG_CONFIG_HOME = CONFIG
process.env.XDG_STATE_HOME = STATE
after(() => {
  if (savedEnv.config === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedEnv.config
  if (savedEnv.state === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedEnv.state
  rmSync(CONFIG, { recursive: true, force: true })
  rmSync(STATE, { recursive: true, force: true })
})

// A setting the user's real micromanager.jsonc would make: written into the stand-in config dir, removed afterwards.
async function withAutoMerge(value: boolean, body: () => Promise<void>): Promise<void> {
  const file = join(CONFIG, "opencode", "micromanager.jsonc")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ autoMerge: value }))
  try {
    await body()
  } finally {
    rmSync(file, { force: true })
  }
}

// --- a real repository with the job's worktree in it, as prepareIntegration leaves them -----------------------

const JOB_ID = "job-1"

// The job's integration worktree under the project's state directory, as prepareIntegration makes it.
function worktreeOf(repo: string): string {
  return join(repo, DIR, "worktrees", JOB_ID)
}

function autoRepo(): { repo: string; wt: string; base: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), "micromanager-automerge-"))
  const wt = worktreeOf(repo)
  // cwd on every call: git's `worktree add` spawns a plain `git branch` child that resolves the repository from the
  // process cwd, not from the parent's -C; without cwd the child finds the test runner's repository (read-only) and dies.
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", cwd: repo }).trim()
  execFileSync("git", ["init", "-q", "-b", "main", "."], { encoding: "utf8", cwd: repo })
  git("config", "user.name", "t")
  git("config", "user.email", "t@t")
  writeFileSync(join(repo, "base.txt"), "base\n")
  writeFileSync(join(repo, "mine.txt"), "the user's\n") // a tracked file no job touches: for uncommitted edits
  git("add", "-A")
  git("commit", "-qm", "base")
  execFileSync("git", ["worktree", "add", "-q", "-b", `jev/${JOB_ID}`, wt, "HEAD"], { encoding: "utf8", cwd: repo })
  excludeFromGit(repo) // the worktree inside the checkout must not count as the user's uncommitted work
  return { repo, wt, base: git("rev-parse", "HEAD"), git }
}

function autoTest(name: string, fn: (r: ReturnType<typeof autoRepo>) => Promise<void>): void {
  test(name, async () => {
    const r = autoRepo()
    try {
      await fn(r)
    } finally {
      rmSync(r.repo, { recursive: true, force: true })
    }
  })
}

function task(id: string, status: Task["status"]): Task {
  return {
    id,
    title: id,
    description: id,
    role: "coder",
    acceptance: [],
    dependsOn: [],
    files: [],
    wave: 1,
    status,
    attempts: 1,
    stages: [],
    signatures: [],
  }
}

// A job in the shape the runner leaves it in when its last task was merged: all tasks done, its integration recorded.
function autoJob(r: ReturnType<typeof autoRepo>, phase: Job["phase"] = "execute"): Job {
  return {
    id: JOB_ID,
    goal: "test job",
    phase,
    acceptance: [{ id: "A1", text: "work is in", verify: "test -f work.txt" }],
    decisions: [],
    tasks: [task("T1", "merged")],
    integrationBranch: `jev/${JOB_ID}`,
    integrationWorktree: r.wt,
    integrationCheckout: "main",
    integrationBase: r.base,
    budget: { workersMax: 1, workersUsed: 1, turnsMax: 10, replansMax: 1 },
    counters: { turns: 1, stalls: 0, replans: 0 },
    lessons: [],
    created: "2026-10-30T09:00:00.000Z",
    updated: "2026-10-30T09:00:00.000Z",
  }
}

// A commit on the job's branch, as the runner's last step makes one.
function commitBranch(r: ReturnType<typeof autoRepo>, file: string, text: string): void {
  writeFileSync(join(r.wt, file), text)
  execFileSync("git", ["add", "-A"], { encoding: "utf8", cwd: r.wt })
  execFileSync("git", ["commit", "-qm", "T1: done"], { encoding: "utf8", cwd: r.wt })
}

// A commit in the user's checkout.
function commitCheckout(r: ReturnType<typeof autoRepo>, file: string, text: string): void {
  writeFileSync(join(r.repo, file), text)
  r.git("add", "-A")
  r.git("commit", "-qm", "checkout change")
}

// A skipped call merges nothing, writes no note and does not record anything.
function skipped(outcome: AutoMergeOutcome, why = ""): void {
  assert.deepEqual(outcome, {}, why)
}

// --- the matrix ------------------------------------------------------------------------------------------------

autoTest("a completed job auto-merges fast-forward, is recorded, and undo_merge takes it back", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const from = r.git("rev-parse", "HEAD") // the checkout's HEAD before the merge
  const to = r.git("rev-parse", `jev/${JOB_ID}`)
  const job = autoJob(r)
  saveJob(r.repo, job)
  const recorded: unknown[] = []

  const outcome = await maybeAutoMerge(r.repo, job, { record: (entry) => recorded.push(entry) })
  assert.ok(outcome.merged, "the merge happened")
  assert.deepEqual(outcome.merged, { from, to, at: outcome.merged.at })
  assert.match(outcome.note ?? "", /merged into the checkout automatically/)
  assert.equal(r.git("rev-parse", "HEAD"), to, "the checkout fast-forwarded to the branch")
  assert.equal(readFileSync(join(r.repo, "work.txt"), "utf8"), "done\n")
  // job.merges: recorded on the job object and saved for undo_merge.
  assert.deepEqual(job.merges, [{ from, to, at: outcome.merged.at }])
  assert.deepEqual(loadJob(r.repo, JOB_ID)!.merges, [{ from, to, at: outcome.merged.at }])
  assert.deepEqual(recorded, [{ kind: "merge", job: JOB_ID, branch: `jev/${JOB_ID}`, auto: true, from, to }])

  // undo_merge takes the automatic merge back exactly as it takes a manual one.
  const undo = await undoMerge(r.repo, loadJob(r.repo, JOB_ID)!, "yes")
  assert.equal(undo.undid, true)
  assert.equal(r.git("rev-parse", "HEAD"), from, "the checkout is back where it was before the merge")
  assert.ok(!existsSync(join(r.repo, "work.txt")), "the branch's work is out of the checkout")
  assert.equal(r.git("rev-parse", `jev/${JOB_ID}`), to, "the commits stay on the job's branch")
  assert.equal(readFileSync(join(r.repo, "base.txt"), "utf8"), "base\n")
  assert.equal(readFileSync(join(r.repo, "mine.txt"), "utf8"), "the user's\n")
  assert.deepEqual(loadJob(r.repo, JOB_ID)!.merges, [{ from, to, at: outcome.merged.at }], "undoMerge does not rewrite the job: dropping the stale entry is the caller's")
})

autoTest("autoMerge off means no merge, however finished the job is", async (r) => {
  await withAutoMerge(false, async () => {
    commitBranch(r, "work.txt", "done\n")
    const head = r.git("rev-parse", "HEAD")
    const outcome = await maybeAutoMerge(r.repo, autoJob(r))
    skipped(outcome)
    assert.equal(r.git("rev-parse", "HEAD"), head, "the checkout is untouched")
    assert.ok(!existsSync(join(r.repo, "work.txt")))
  })
})

autoTest("a dirty checkout with an unrelated edit merges and keeps the edit", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  // Two edits nothing on the branch touches: one untracked, one a tracked file left as it is committed.
  writeFileSync(join(r.repo, "user.md"), "the user's notes\n")
  writeFileSync(join(r.repo, "mine.txt"), "the user's edit\n")
  const before = r.git("rev-parse", "HEAD")

  const outcome = await maybeAutoMerge(r.repo, autoJob(r))
  assert.ok(outcome.merged, "the unrelated edit does not stop the merge (allowDirty)")
  assert.equal(r.git("rev-parse", "HEAD") !== before, true, "the checkout moved")
  assert.equal(readFileSync(join(r.repo, "mine.txt"), "utf8"), "the user's edit\n", "the uncommitted tracked edit stands")
  assert.equal(readFileSync(join(r.repo, "user.md"), "utf8"), "the user's notes\n", "the untracked file stands")
  assert.equal(readFileSync(join(r.repo, "work.txt"), "utf8"), "done\n")
})

autoTest("a dirty checkout whose edit overlaps the merge is skipped and unchanged", async (r) => {
  commitBranch(r, "base.txt", "job change\n")
  writeFileSync(join(r.repo, "base.txt"), "uncommitted\n")
  const before = r.git("rev-parse", "HEAD")
  const outcome = await maybeAutoMerge(r.repo, autoJob(r))
  assert.ok(!outcome.merged)
  assert.equal(outcome.reason, "ff")
  assert.match(outcome.note ?? "", /not merged into the checkout automatically \(ff/)
  assert.equal(r.git("rev-parse", "HEAD"), before, "the fast-forward either happens whole or not at all")
  assert.equal(readFileSync(join(r.repo, "base.txt"), "utf8"), "uncommitted\n", "the user's edit is left as it was")
})

autoTest("a diverged checkout: the job branch is rebased, the checks rerun there, then it fast-forwards", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  commitCheckout(r, "main.txt", "checkout change\n")
  const from = r.git("rev-parse", "HEAD")
  const oldTip = r.git("rev-parse", `jev/${JOB_ID}`)
  const job = autoJob(r)

  const outcome = await maybeAutoMerge(r.repo, job)
  assert.ok(outcome.merged, "the diverged job still lands")
  const to = r.git("rev-parse", "HEAD")
  assert.deepEqual(outcome.merged, { from, to, at: outcome.merged!.at })
  assert.notEqual(r.git("rev-parse", `jev/${JOB_ID}`), oldTip, "the branch was rewritten onto the checkout's HEAD")
  assert.equal(r.git("rev-parse", `jev/${JOB_ID}^`), from, "the branch's parent is the checkout's HEAD")
  // The rerun check is the job's acceptance verify, "test -f work.txt": it only passes in the job's worktree, after the
  // rebase brought the branch's work on top of the checkout's HEAD. The recorded merge proves it passed.
  assert.equal(readFileSync(join(r.repo, "work.txt"), "utf8"), "done\n")
  assert.equal(readFileSync(join(r.repo, "main.txt"), "utf8"), "checkout change\n")
  assert.deepEqual(job.merges, [{ from, to, at: outcome.merged!.at }])
})

autoTest("a rebase conflict skips the merge and leaves the branch tip and the checkout unchanged", async (r) => {
  commitBranch(r, "base.txt", "job change\n")
  commitCheckout(r, "base.txt", "checkout change\n") // both sides touched base.txt
  const head = r.git("rev-parse", "HEAD")
  const branchTip = r.git("rev-parse", `jev/${JOB_ID}`)
  const job = autoJob(r)

  const outcome = await maybeAutoMerge(r.repo, job)
  assert.ok(!outcome.merged)
  assert.equal(outcome.reason, "conflict")
  assert.match(outcome.note ?? "", /not merged into the checkout automatically/)
  assert.equal(r.git("rev-parse", `jev/${JOB_ID}`), branchTip, "the branch tip is unchanged")
  assert.equal(r.git("rev-parse", "HEAD"), head, "the checkout's HEAD is unchanged")
  assert.equal(execFileSync("git", ["diff", "--quiet"], { encoding: "utf8", cwd: r.wt }), "", "the job worktree is clean again")
  assert.equal(readFileSync(join(r.repo, "base.txt"), "utf8"), "checkout change\n", "the user's commit stands")
  assert.equal(job.merges, undefined, "nothing was recorded")
})

autoTest("a checkout on another branch, or detached, is skipped", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const head = r.git("rev-parse", "HEAD")
  r.git("checkout", "-q", "-b", "feature")
  let outcome = await maybeAutoMerge(r.repo, autoJob(r))
  assert.ok(!outcome.merged)
  assert.equal(outcome.reason, "other-branch")
  assert.match(outcome.note ?? "", /on feature, not on main/)
  assert.equal(r.git("rev-parse", "HEAD"), head)

  r.git("checkout", "-q", "--detach")
  outcome = await maybeAutoMerge(r.repo, autoJob(r))
  assert.ok(!outcome.merged)
  assert.equal(outcome.reason, "other-branch")
  assert.match(outcome.note ?? "", /detached/)
  assert.equal(r.git("rev-parse", "HEAD"), head)

  r.git("checkout", "-q", "main")
  const back = await maybeAutoMerge(r.repo, autoJob(r))
  assert.ok(back.merged, "back on the recorded branch, the job merges")
})

autoTest("an unfinished task is skipped", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const job = autoJob(r)
  job.tasks = [task("T1", "merged"), task("T2", "running")]
  const head = r.git("rev-parse", "HEAD")
  skipped(await maybeAutoMerge(r.repo, job))
  assert.equal(r.git("rev-parse", "HEAD"), head)
})

autoTest("a job with no merged task is skipped", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const job = autoJob(r)
  const head = r.git("rev-parse", "HEAD")

  const resigned = autoJob(r)
  resigned.tasks = [task("T1", "passed"), task("T2", "cancelled")]
  skipped(await maybeAutoMerge(r.repo, resigned), "done tasks, but the job is complete only through the one read as merged")

  const neverMerged = autoJob(r)
  neverMerged.tasks = [task("T1", "cancelled")]
  skipped(await maybeAutoMerge(r.repo, neverMerged), "no task was ever merged")
  assert.equal(r.git("rev-parse", "HEAD"), head)
})

autoTest("a passed task with a worktree of its own waits for the merge train; a passed reader does not", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const head = r.git("rev-parse", "HEAD")
  const writer = autoJob(r)
  const later = task("T2", "passed")
  later.worktree = "/tmp/wt-T2" // its own worktree: its commits are still there, not on the job's branch
  writer.tasks = [task("T1", "merged"), later]
  skipped(await maybeAutoMerge(r.repo, writer), "T2 is not integrated yet")

  const reader = autoJob(r)
  reader.tasks = [task("T1", "merged"), task("T2", "passed")] // no worktree, nothing left to merge
  const outcome = await maybeAutoMerge(r.repo, reader)
  assert.ok(outcome.merged, "a passed task without a worktree counts as done")
  assert.notEqual(r.git("rev-parse", "HEAD"), head)
})

autoTest("a halted job is skipped, and a job with no integration checkout is skipped", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const head = r.git("rev-parse", "HEAD")
  const job = autoJob(r, "done") // paused, stopped, failed, ask_user and done all merge by nobody
  skipped(await maybeAutoMerge(r.repo, job))
  assert.equal(r.git("rev-parse", "HEAD"), head)

  const noIntegration = autoJob(r)
  noIntegration.integrationCheckout = undefined
  skipped(await maybeAutoMerge(r.repo, noIntegration))
  assert.equal(r.git("rev-parse", "HEAD"), head)

  // "HEAD" is what a detached checkout once recorded as a branch; it names no branch to merge onto.
  const detached = autoJob(r)
  detached.integrationCheckout = "HEAD"
  skipped(await maybeAutoMerge(r.repo, detached), "\"HEAD\" is not a branch")
  assert.equal(r.git("rev-parse", "HEAD"), head)
})

autoTest("a second call is a no-op: already merged, nothing recorded twice", async (r) => {
  commitBranch(r, "work.txt", "done\n")
  const job = autoJob(r)
  saveJob(r.repo, job)
  const first = await maybeAutoMerge(r.repo, job)
  assert.ok(first.merged)
  const second = await maybeAutoMerge(r.repo, job)
  skipped(second)
  assert.equal(job.merges!.length, 1, "the merge was recorded once")
  assert.equal(loadJob(r.repo, JOB_ID)!.merges!.length, 1)
})
