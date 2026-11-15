import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { statePath } from "../packages/core/src/paths.ts"
import { MAX_FILE_BYTES } from "../packages/micromanager/src/nogit.ts"
import { copyOne, parseArtifacts, promoteArtifacts, writePromotionRecord, type Promotion } from "../packages/micromanager/src/promote.ts"
import { docFromJob, parsePlanDoc, planDocPath, readPlanDoc, renderPlanDoc, writePlanDoc, type PlanDoc } from "../packages/micromanager/src/plandoc.ts"
import { IntegrationError, preparePlanWorktree, removePlanWorktree } from "../packages/micromanager/src/worktree/git.ts"
import { applySplits, checkCwdProblem, parsePlan, planModeRoles, readerOnlyNote, stripTaskWorktreeCwd, type Plan } from "../packages/micromanager/src/plan.ts"
import { planText } from "../packages/micromanager/src/tools.ts"
import { newJob, type Task } from "../packages/micromanager/src/state.ts"
import { tempDir } from "./harness.ts"

const fence = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```"
const base = parsePlan(fence({
  acceptance: [{ id: "A1", text: "parser" }, { id: "A2", text: "cli" }, { id: "A3", text: "docs" }],
  tasks: [
    { id: "T1", title: "parser and cli", role: "code", acceptance: ["A1", "A2"], dependsOn: [], files: ["parse.js", "cli.js"] },
    { id: "T2", title: "docs", role: "write", acceptance: ["A3"], dependsOn: ["T1"], files: ["README.md"] },
  ],
})).plan as Plan

const split = (kids: unknown[], acceptance: unknown[] = []) => applySplits(base, fence({ acceptance, splits: { T1: kids } }), ["T1"])

test("children replace their parent, and the tasks that waited for it wait for its last children", () => {
  const r = split([
    { id: "T1.1", title: "parser", role: "code", acceptance: ["A1"], dependsOn: [], files: ["parse.js"] },
    { id: "T1.2", title: "cli", role: "code", acceptance: ["A2", "A4"], dependsOn: ["T1.1"], files: ["cli.js"] },
  ], [{ id: "A4", text: "cli --help works", verify: "node cli.js --help" }])
  assert.equal(r.errors, undefined, String(r.errors))
  assert.deepEqual(r.plan!.tasks.map((t) => [t.id, t.parent ?? "", t.dependsOn.join()]), [["T1.1", "T1", ""], ["T1.2", "T1", "T1.1"], ["T2", "", "T1.2"]])
  assert.ok(r.plan!.acceptance.some((a) => a.id === "A4"))
})

test("an investigator declares the draft it writes, like every other writer", () => {
  const plan = (files: string[]) => fence({
    acceptance: [{ id: "A1", text: "the question is answered" }],
    tasks: [{ id: "T1", title: "investigate the parser", role: "investigator", acceptance: ["A1"], dependsOn: [], files }],
  })
  const ok = parsePlan(plan(["docs/parser-draft.md"]))
  assert.equal(ok.errors, undefined, String(ok.errors))
  assert.equal(ok.plan!.tasks[0]!.role, "investigator")
  assert.match(String(parsePlan(plan([])).errors), /writes/)
})

test("a split is rejected when it leaves the parent's scope, drops a point, has one part, or only adds coordination", () => {
  const ok = { id: "T1.1", title: "parser", role: "code", acceptance: ["A1"], dependsOn: [], files: ["parse.js"] }
  assert.match(String(split([ok, { ...ok, id: "T1.2", acceptance: ["A2"], files: ["other.js"] }]).errors), /changes files outside T1's/)
  assert.match(String(split([ok, { ...ok, id: "T1.2", acceptance: ["A1"] }]).errors), /no part covers A2/)
  assert.match(String(split([{ ...ok, acceptance: ["A1", "A2"] }]).errors), /at least two tasks/)
  assert.match(String(split([{ ...ok, acceptance: ["A1", "A2"] }, { ...ok, id: "T1.2", acceptance: ["A1", "A2"] }]).errors), /only adds coordination/)
  assert.match(String(split([ok, { ...ok, id: "X2", acceptance: ["A2"], files: ["cli.js"] }]).errors), /must be named T1.<n>/)
  assert.match(String(applySplits(base, fence({ splits: { T2: [] } }), ["T1"]).errors), /not one of the tasks to split/)
  assert.match(String(applySplits(base, "nope", ["T1"]).errors), /no JSON/)
})

test("a check may not cd out of the task worktree; the main checkout and another task worktree are named", () => {
  const dir = "/p/wt/a/b/c"
  const wt = "/p/wt"
  assert.equal(checkCwdProblem("npm test", dir, wt, "/p"), undefined)
  assert.equal(checkCwdProblem("cd subdir && npm test", dir, wt, "/p"), undefined)
  assert.equal(checkCwdProblem("cd ../.. && npm test", dir, wt, "/p"), undefined, "the worktree root is still inside")
  assert.match(checkCwdProblem("cd /p && npm test", dir, wt, "/p")!, /user's checkout/)
  assert.match(checkCwdProblem("cd /p/sub && npm test", "/p", "/p", "/p")!, /absolute path .* inside the user's checkout/)
  assert.match(checkCwdProblem("cd ../../../.. && npm test", dir, wt, "/p")!, /user's checkout/)
  assert.match(checkCwdProblem("cd /tmp && npm test", dir, wt, "/p")!, /outside the task worktree/)
  assert.match(checkCwdProblem("cd - && npm test", dir, wt, "/p")!, /outside the task worktree/)
  assert.equal(checkCwdProblem("echo cd /p", dir, wt, "/p"), undefined, "a word in an argument is not a cd")
  assert.match(checkCwdProblem('cd "$HOME" && npm test', dir, wt, "/p")!, /shell expression/)
  // The stale path from an earlier task worktree is stripped only for a root project.
  assert.equal(stripTaskWorktreeCwd("cd /p/.micromanager/worktrees/job-1--T1 && pytest", ""), "pytest")
  assert.equal(stripTaskWorktreeCwd("cd /p/.micromanager/worktrees/job-1--T1 && pytest", "a/b/c"), "cd /p/.micromanager/worktrees/job-1--T1 && pytest")
  assert.match(checkCwdProblem("cd /p/.micromanager/worktrees/job-1--T1 && pytest", "/p", "/p", "/p")!, /another task worktree/)
})

// --- Plan worktrees ------------------------------------------------------------------------------------------

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

function repo(prefix: string): string {
  const dir = tempDir(prefix)
  git(dir, "init", "-q")
  git(dir, "config", "user.name", "t")
  git(dir, "config", "user.email", "t@t")
  writeFileSync(join(dir, "base.txt"), "base\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "base")
  return dir
}

test("a plan worktree is a throwaway branch off HEAD under the state directory, and removal is safe twice", async () => {
  const project = repo("mm-plan-worktree-")
  try {
    const head = git(project, "rev-parse", "HEAD")
    const w = await preparePlanWorktree(project, "job-1", "T1")
    assert.equal(w.branch, "plan/job-1/T1")
    assert.equal(w.worktree, statePath(project, "plan", "job-1", "worktrees", "T1"), "the worktree is under the project's state directory")
    assert.equal(w.dir, w.worktree)
    assert.equal(w.base, head)
    assert.equal(git(w.worktree, "rev-parse", "HEAD"), head, "it starts at the project's HEAD")
    assert.equal(git(w.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "plan/job-1/T1")

    await removePlanWorktree(project, w)
    assert.equal(existsSync(w.worktree), false, "the worktree directory is gone")
    assert.equal(git(project, "branch", "--list", w.branch), "", "the branch is gone")
    await removePlanWorktree(project, w) // cleanup on a job's end may remove it a second time
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("a project without a commit has no base for a plan worktree", async () => {
  const project = tempDir("mm-plan-nocommit-")
  try {
    git(project, "init", "-q")
    await assert.rejects(() => preparePlanWorktree(project, "job-1", "T1"), (err: unknown) => err instanceof IntegrationError && /no commit/.test((err as Error).message))
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

// --- Artifacts promoted out of a plan worktree (A1-T3a) ------------------------------------------------------

// A throwaway worktree (the boundary) and a project whose state directory receives the copies, both under one parent
// that the "outside" cases and the cleanup use. The report paths are relative to the worktree root, the common case.
function area(): { parent: string; root: string; project: string; dest: string; promote: (paths: readonly string[]) => Promotion } {
  const parent = tempDir("mm-promote-")
  const root = join(parent, "worktree")
  const project = join(parent, "project")
  mkdirSync(root, { recursive: true })
  mkdirSync(project, { recursive: true })
  const promote = (paths: readonly string[]) => promoteArtifacts({ project, jobId: "job-1", taskId: "T1", root, dir: root, paths })
  return { parent, root, project, dest: statePath(project, "plan", "job-1", "artifacts", "T1"), promote }
}

// Every entry under a directory, so a test can say "no symlink anywhere" rather than "not the one I thought of".
function entries(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      out.push(path)
      if (lstatSync(path).isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}

test("the Artifacts: line is read off a report: comma-separated, backticks and all", () => {
  assert.deepEqual(parseArtifacts("Done.\nArtifacts: notes.md, `out/report.pdf`\nMore text."), ["notes.md", "out/report.pdf"])
  assert.deepEqual(parseArtifacts("Artifacts: a.md, b.md\nArtifacts: c/d.md"), ["a.md", "b.md", "c/d.md"])
  assert.deepEqual(parseArtifacts("Artifacts: none"), [], "a report that says none names no file")
  assert.deepEqual(parseArtifacts("no artifacts: this line is prose"), [])
})

test("a named file is promoted byte for byte, mode 0600, with the source's sha256", () => {
  const a = area()
  try {
    const content = "the note\n"
    writeFileSync(join(a.root, "notes.md"), content)
    const r = a.promote(["notes.md"])
    assert.equal(r.ok, true, JSON.stringify(r.rejected))
    assert.deepEqual(r.promoted.map((p) => p.path), ["notes.md"])
    assert.equal(r.promoted[0]!.bytes, Buffer.byteLength(content))
    assert.equal(r.promoted[0]!.sha256, createHash("sha256").update(content).digest("hex"))
    const dest = join(a.dest, "notes.md")
    assert.equal(readFileSync(dest, "utf8"), content)
    assert.equal(statSync(dest).mode & 0o777, 0o600, "the copy is private to the user")
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a directory is promoted whole, and nothing under the destination is a symlink", () => {
  const a = area()
  try {
    mkdirSync(join(a.root, "out", "sub"), { recursive: true })
    writeFileSync(join(a.root, "out", "a.txt"), "a\n")
    writeFileSync(join(a.root, "out", "sub", "b.txt"), "b\n")
    const r = a.promote(["out"])
    assert.equal(r.ok, true, JSON.stringify(r.rejected))
    assert.deepEqual(r.promoted.map((p) => p.path).sort(), ["out/a.txt", "out/sub/b.txt"])
    assert.equal(readFileSync(join(a.dest, "out", "sub", "b.txt"), "utf8"), "b\n")
    assert.equal(statSync(join(a.dest, "out")).mode & 0o777, 0o700, "its directories are private too")
    for (const entry of entries(a.dest)) assert.equal(lstatSync(entry).isSymbolicLink(), false, `${entry} is not a link`)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a symlinked artifact is refused, and so is a directory with a symlink inside it", () => {
  const a = area()
  try {
    writeFileSync(join(a.root, "real.md"), "real\n")
    symlinkSync(join(a.root, "real.md"), join(a.root, "link.md"))
    const link = a.promote(["link.md"])
    assert.equal(link.ok, false)
    assert.match(link.rejected[0]!.reason, /a symlink in the artifact path/)
    assert.equal(existsSync(join(a.dest, "link.md")), false)

    mkdirSync(join(a.root, "bundle"))
    writeFileSync(join(a.root, "bundle", "ok.md"), "ok\n")
    symlinkSync(join(a.root, "real.md"), join(a.root, "bundle", "inside.md"))
    const nested = a.promote(["bundle"])
    assert.equal(nested.ok, false, "one link inside refuses the whole directory")
    assert.match(nested.rejected[0]!.reason, /nested symlink in bundle\/inside\.md/)
    assert.deepEqual(nested.promoted, [])
    assert.equal(existsSync(join(a.dest, "bundle")), false, "nothing of the refused directory was written")
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a path that climbs out with .. is refused; an internal a/../b is just b", () => {
  const a = area()
  try {
    writeFileSync(join(a.parent, "outside.txt"), "outside\n")
    writeFileSync(join(a.root, "b.txt"), "b\n")
    mkdirSync(join(a.root, "a"))
    const up = a.promote(["../outside.txt"])
    assert.equal(up.ok, false)
    assert.match(up.rejected[0]!.reason, /escapes the worktree with `\.\.`/)
    const deep = a.promote(["a/../../x"])
    assert.equal(deep.ok, false)
    assert.match(deep.rejected[0]!.reason, /escapes the worktree with `\.\.`/)
    const inside = a.promote(["a/../b.txt"])
    assert.equal(inside.ok, true, JSON.stringify(inside.rejected))
    assert.equal(readFileSync(join(a.dest, "b.txt"), "utf8"), "b\n")
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("an absolute path is refused, and a path naming no file is refused", () => {
  const a = area()
  try {
    writeFileSync(join(a.root, "notes.md"), "x\n")
    const absolute = a.promote([join(a.root, "notes.md")])
    assert.equal(absolute.ok, false)
    assert.match(absolute.rejected[0]!.reason, /absolute path/)
    const empty = a.promote([""])
    assert.match(empty.rejected[0]!.reason, /names no file/)
    const self = a.promote(["."])
    assert.match(self.rejected[0]!.reason, /names no file/)
    const slash = a.promote(["out/"])
    assert.match(slash.rejected[0]!.reason, /names no file/)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("paths resolve against the project directory inside the worktree, not against its root", () => {
  const a = area()
  try {
    mkdirSync(join(a.root, "pkg", "sub"), { recursive: true })
    writeFileSync(join(a.root, "pkg", "sub", "note.md"), "n\n")
    writeFileSync(join(a.root, "at-root.md"), "root\n")
    const r = promoteArtifacts({ project: a.project, jobId: "job-1", taskId: "T1", root: a.root, dir: join(a.root, "pkg", "sub"), paths: ["note.md", "at-root.md"] })
    assert.deepEqual(r.promoted.map((p) => p.path), ["note.md"])
    assert.match(r.rejected[0]!.reason, /cannot be read/, "a file above the project directory is not the report's to name")
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a FIFO, a file over the size cap and a secret are refused", () => {
  const a = area()
  try {
    let fifo = true
    try {
      execFileSync("mkfifo", [join(a.root, "pipe")])
    } catch {
      fifo = false // a platform that refuses to make one cannot be tested for one
    }
    if (fifo) {
      const r = a.promote(["pipe"])
      assert.equal(r.ok, false)
      assert.match(r.rejected[0]!.reason, /fifo/)
    }
    writeFileSync(join(a.root, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 97))
    const big = a.promote(["big.bin"])
    assert.equal(big.ok, false)
    assert.match(big.rejected[0]!.reason, /over the size cap/)
    assert.equal(existsSync(join(a.dest, "big.bin")), false)

    writeFileSync(join(a.root, "key.md"), "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n")
    const secret = a.promote(["key.md"])
    assert.equal(secret.ok, false)
    assert.match(secret.rejected[0]!.reason, /contains a secret/)
    assert.equal(existsSync(join(a.dest, "key.md")), false)

    writeFileSync(join(a.root, ".env"), "harmless=1\n")
    const named = a.promote([".env"])
    assert.equal(named.ok, false)
    assert.match(named.rejected[0]!.reason, /a secret file name/)
    assert.equal(existsSync(join(a.dest, ".env")), false)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a file swapped after it was checked is not copied: the opened descriptor must be the inspected inode", () => {
  const a = area()
  try {
    writeFileSync(join(a.root, "note.md"), "first\n")
    const seen = lstatSync(join(a.root, "note.md"))
    const dest = join(a.parent, "copied.md")
    const ok = copyOne(join(a.root, "note.md"), dest, { dev: seen.dev, ino: seen.ino })
    assert.ok("sha256" in ok, String((ok as { reason?: string }).reason))
    assert.equal(readFileSync(dest, "utf8"), "first\n")
    // A different file at the same path: a parent directory swapped for a symlink looks the same from the descriptor, and
    // that is exactly what the dev/ino check has to refuse.
    rmSync(join(a.root, "note.md"))
    writeFileSync(join(a.root, "note.md"), "second\n")
    const swapped = copyOne(join(a.root, "note.md"), join(a.parent, "swapped.md"), { dev: seen.dev, ino: seen.ino })
    assert.ok("reason" in swapped)
    assert.match(swapped.reason, /changed while it was checked/)
    assert.equal(existsSync(join(a.parent, "swapped.md")), false)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a plan job's planner is told to use investigators, and a build job's is not", () => {
  assert.match(planModeRoles({ isolation: "plan" }), /"investigator"/)
  assert.match(planModeRoles({ isolation: "plan" }), /no task changes the project/)
  assert.equal(planModeRoles({ isolation: "none" }), "")
  assert.equal(planModeRoles({}), "")
})

test("a job that ran reader-only says so in its plan and in job_status's note", () => {
  const job = newJob("job-20261115-094500-ab12", "find out how it works")
  assert.equal(readerOnlyNote(job), "", "a job with a sandbox says nothing")
  assert.doesNotMatch(planText(job), /reader-only/)
  job.planReaderOnly = "no sandbox on this machine"
  assert.match(readerOnlyNote(job), /This job ran reader-only: no sandbox on this machine, so no investigator changed or wrote anything\./)
  assert.match(planText(job), /This job ran reader-only: no sandbox on this machine/)
})

test("one refused path does not stop the others, and a repeated path is copied once", () => {
  const a = area()
  try {
    writeFileSync(join(a.root, "one.md"), "1\n")
    writeFileSync(join(a.root, "two.md"), "2\n")
    const r = a.promote(["one.md", "../escape.md", "two.md", "one.md"])
    assert.equal(r.ok, false, "the report is not clean, even though most of it was promoted")
    assert.deepEqual(r.promoted.map((p) => p.path), ["one.md", "two.md"])
    assert.equal(r.rejected.length, 1)
    assert.equal(existsSync(join(a.dest, "one.md")), true)
    assert.equal(existsSync(join(a.dest, "two.md")), true)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

// --- The record a plan task leaves behind (A1-T3b) -----------------------------------------------------------

interface Manifest {
  version: number
  job: string
  task: string
  title: string
  at: string
  checks: string[]
  git: { base: string; head: string } | null
  patch: string | null
  patchBytes?: number
  findings: string
  artifacts: { path: string; bytes: number; sha256: string }[]
  rejected: { path: string; reason: string }[]
  note?: string
}

const manifestOf = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest

test("a plan task's record is the patch, its findings, and a manifest that hashes what was promoted", () => {
  const a = area()
  try {
    writeFileSync(join(a.root, "notes.md"), "the note\n")
    const promotion = a.promote(["notes.md"])
    const patch = "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+the note\n"
    const report = "wrote the note\nArtifacts: notes.md"
    const r = writePromotionRecord({ project: a.project, jobId: "job-1", taskId: "T1", title: "work it out", report, promotion, checks: ["test -f notes.md"], git: { base: "a".repeat(40), head: "b".repeat(40), patch } })
    const plan = statePath(a.project, "plan", "job-1")
    assert.equal(r.patch, join(plan, "patches", "T1.patch"), "the patch is under the plan area")
    assert.equal(r.findings, join(plan, "findings", "T1.md"))
    assert.equal(r.manifest, join(plan, "artifacts", "T1", "manifest.json"))
    assert.equal(readFileSync(r.patch!, "utf8"), patch, "the patch is written as it was given")
    assert.equal(statSync(r.patch!).mode & 0o777, 0o600)

    const findings = readFileSync(r.findings, "utf8")
    assert.match(findings, /^# T1 — work it out$/m)
    assert.match(findings, /plan job job-1/)
    assert.ok(findings.endsWith(`## Findings\n\n${report}\n`), "the worker's report is there verbatim")
    assert.equal(statSync(r.findings).mode & 0o777, 0o600)

    const m = manifestOf(r.manifest)
    assert.equal(m.version, 1)
    assert.equal(m.job, "job-1")
    assert.equal(m.task, "T1")
    assert.equal(m.title, "work it out")
    assert.ok(!Number.isNaN(Date.parse(m.at)), "at is an ISO time")
    assert.deepEqual(m.checks, ["test -f notes.md"])
    assert.deepEqual(m.git, { base: "a".repeat(40), head: "b".repeat(40) })
    assert.equal(m.patch, "patches/T1.patch")
    assert.equal(m.patchBytes, Buffer.byteLength(patch))
    assert.equal(m.findings, "findings/T1.md")
    assert.deepEqual(m.artifacts, [{ path: "notes.md", bytes: 9, sha256: createHash("sha256").update("the note\n").digest("hex") }])
    assert.deepEqual(m.rejected, [])
    assert.equal(m.note, undefined, "a git record makes no excuse for a missing patch")
    assert.equal(statSync(r.manifest).mode & 0o777, 0o600)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a plan without git records no patch, and the manifest says why", () => {
  const a = area()
  try {
    const r = writePromotionRecord({ project: a.project, jobId: "job-1", taskId: "T1", title: "work it out", report: "read the code", promotion: { ok: true, promoted: [], rejected: [] }, checks: [] })
    assert.equal(r.patch, undefined)
    assert.equal(existsSync(join(statePath(a.project, "plan", "job-1"), "patches")), false, "no patch directory is made")
    const m = manifestOf(r.manifest)
    assert.equal(m.git, null)
    assert.equal(m.patch, null)
    assert.equal(m.note, "no git in this project: there is no patch")
    assert.match(readFileSync(r.findings, "utf8"), /## Findings\n\nread the code\n/)
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

test("a patch that changed nothing is written anyway, and the manifest counts it as empty", () => {
  const a = area()
  try {
    const promotion = { ok: true, promoted: [], rejected: [] }
    const r = writePromotionRecord({ project: a.project, jobId: "job-1", taskId: "T1", title: "read only", report: "nothing to write", promotion, checks: [], git: { base: "c".repeat(40), head: "c".repeat(40), patch: "" } })
    assert.equal(readFileSync(r.patch!, "utf8"), "")
    assert.equal(manifestOf(r.manifest).patchBytes, 0, "an empty patch is recorded as such")
    assert.deepEqual(manifestOf(r.manifest).artifacts, [])
  } finally {
    rmSync(a.parent, { recursive: true, force: true })
  }
})

// --- The plan document Build mode reads (A1-T8) --------------------------------------------------------------

const doc = (extra: Partial<PlanDoc> = {}): PlanDoc => ({
  goal: "know how add.js is built",
  findings: ["add.js adds two numbers", "the README says nothing about it"],
  decisions: ["read the code rather than the tests"],
  openQuestions: ["which module owns the parser?"],
  tasks: [
    { id: "T1", title: "read add.js", role: "explore", files: [], acceptance: ["A1"] },
    { id: "T2", title: "write the note", role: "investigator", files: ["note.md", "draft.md"], acceptance: ["A1", "A2"] },
  ],
  artifacts: [{ task: "T2", path: "note.md", bytes: 24, sha256: "a".repeat(64) }],
  risks: ["the parser is generated"],
  ...extra,
})

test("a plan document round-trips through its headings, artifacts included", () => {
  const text = renderPlanDoc({ id: "job-1" }, doc())
  assert.match(text, /^# job-1 — plan$/m)
  assert.match(text, /^## Recommended tasks$/m)
  assert.match(text, /^- \*\*T2\*\* write the note · role investigator · files: note\.md, draft\.md · acceptance: A1, A2$/m)
  const parsed = parsePlanDoc(text)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.doc, doc())
  // Empty sections say so instead of vanishing, and they read back as empty.
  const empty = { goal: "", findings: [], decisions: [], openQuestions: [], tasks: [], artifacts: [], risks: [] }
  const bare = renderPlanDoc({ id: "job-2" }, empty)
  assert.equal(bare.match(/^\(none\)$/gm)?.length, 7, "every empty section says (none), the goal included")
  assert.deepEqual(parsePlanDoc(bare).doc, empty)
})

test("a reader-only plan says so in its mode line and reads back", () => {
  const flat = renderPlanDoc({ id: "job-1" }, doc())
  assert.doesNotMatch(flat, /\*\*Mode:\*\*/)
  assert.equal(parsePlanDoc(flat).doc?.readerOnly, undefined)

  const text = renderPlanDoc({ id: "job-1" }, doc({ readerOnly: "no sandbox on this machine" }))
  assert.match(text, /^\*\*Mode:\*\* reader-only — no sandbox on this machine$/m)
  assert.equal(parsePlanDoc(text).doc?.readerOnly, "no sandbox on this machine")
  assert.deepEqual(parsePlanDoc(text).doc, doc({ readerOnly: "no sandbox on this machine" }))
})

test("a plan without a Goal or a Recommended tasks heading is refused, and a bad artifact line is named", () => {
  const text = renderPlanDoc({ id: "job-1" }, doc())
  const noGoal = text.replace("## Goal", "## Purpose")
  assert.match(String(parsePlanDoc(noGoal).errors), /no ## Goal section/)
  assert.equal(parsePlanDoc(noGoal).doc, undefined)
  assert.match(String(parsePlanDoc(text.replace("## Recommended tasks", "## Next")).errors), /no ## Recommended tasks section/)
  const broken = text.replace(/^- T2: note\.md .*$/m, "- T2: note.md (24 bytes)")
  assert.match(String(parsePlanDoc(broken).errors), /an artifact cannot be read: "- T2: note\.md \(24 bytes\)"/)
  assert.equal(parsePlanDoc(broken).doc, undefined, "an unreadable line is not silently dropped")
})

test("plan.md lives in the plan area, is written 0600, and a job without one has no document yet", () => {
  const project = tempDir("mm-plandoc-")
  try {
    const missing = readPlanDoc(project, "job-1")
    assert.deepEqual(missing.errors, ["no plan.md yet"])
    assert.equal(missing.path, planDocPath(project, "job-1"))
    assert.equal(missing.path, statePath(project, "plan", "job-1", "plan.md"), "under the plan area, not the project")
    assert.equal(writePlanDoc(project, "job-1", doc()), missing.path)
    assert.equal(statSync(missing.path).mode & 0o777, 0o600)
    assert.deepEqual(readPlanDoc(project, "job-1").doc, doc())
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test("the plan document the plugin guarantees maps the job: tasks, artifacts, findings, risks", () => {
  const job = newJob("job-20261115-110000-ab12", "find out how add.js is built")
  const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `task ${id}`, description: "", role: "investigator", acceptance: ["A1"], dependsOn: [], files: [`${id}.md`],
    wave: 0, status: "pending", attempts: 0, stages: [], signatures: [], ...extra,
  })
  job.decisions = [{ id: "D1", text: "read the code first", origin: "user" }]
  job.lessons = ["the parser is generated"]
  job.tasks = [
    task("T1", { status: "passed", summary: "add.js adds two numbers.\nArtifacts: none", promoted: [{ path: "note.md", bytes: 24, sha256: "b".repeat(64) }] }),
    task("T2", { status: "cancelled" }),
    task("T3"),
  ]
  job.planReaderOnly = "no sandbox on this machine"
  const built = docFromJob(job)
  assert.equal(built.goal, "find out how add.js is built")
  assert.deepEqual(built.tasks.map((t) => t.id), ["T1", "T3"], "a cancelled task is history, not a recommendation")
  assert.deepEqual(built.tasks[0], { id: "T1", title: "task T1", role: "investigator", files: ["T1.md"], acceptance: ["A1"] })
  assert.deepEqual(built.artifacts, [{ task: "T1", path: "note.md", bytes: 24, sha256: "b".repeat(64) }])
  assert.deepEqual(built.findings, ["add.js adds two numbers."], "the summary's first line is the finding")
  assert.deepEqual(built.risks, ["the parser is generated"])
  assert.deepEqual(built.decisions, ["read the code first"])
  assert.deepEqual(built.openQuestions, [])
  assert.equal(built.readerOnly, "no sandbox on this machine")
  assert.deepEqual(parsePlanDoc(renderPlanDoc(job, built)).doc, built, "what the plugin writes is what it can read")
})


