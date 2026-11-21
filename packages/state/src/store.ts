// Where jobs live: <project>/.micromanager/jobs/<id>.json, one file per job, written atomically.
//
// Inside the project, so workers can read their notes without an external_directory ask; kept out of git through
// the repository's own .git/info/exclude, which is local and needs no .gitignore change (design.md §8.2).

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { LEGACY_PROJECT_STATE as LEGACY_DIR, PROJECT_STATE as DIR, stateDir } from "@omacode/core/paths"
import { excludeFromGit, gitCommonDir } from "@omacode/core/project"

import type { Job } from "./state.ts"

export { DIR, LEGACY_DIR, stateDir }

export {
  reconcileJob,
  RECONCILE_STAGE,
  type Orphan,
  type Reconciled,
  type ReconcileOptions,
  type ReconcileResult,
} from "./state.ts"

export function jobsDir(project: string): string {
  return join(project, stateDir(project), "jobs")
}

export function notesDir(project: string, jobId: string): string {
  return join(project, stateDir(project), "notes", jobId)
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// The exclude file and the repository's common directory moved to @omacode/core/project, where the project id needs
// them too; they are re-exported for the callers that know them from here.
export { excludeFromGit, gitCommonDir }

// Whether a file in the backlog would be ignored by git all the same: a .gitignore of the project's own that names the
// whole state directory beats the exclude file's re-include. The caller says so once instead of letting drafts vanish.
export function backlogIgnored(project: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", join(stateDir(project), "backlog", "x.md")], { cwd: project, timeout: 3000, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function saveJob(project: string, job: Job): string {
  const path = join(jobsDir(project), `${job.id}.json`)
  atomicWrite(path, JSON.stringify(job, null, 2) + "\n")
  return path
}

// A truncated or half-written file is a job the user cannot see, not a reason to make every other job invisible too.
export function loadJob(project: string, id: string): Job | undefined {
  const path = join(jobsDir(project), `${id}.json`)
  if (!existsSync(path)) return undefined
  let job: Job
  try {
    job = JSON.parse(readFileSync(path, "utf8")) as Job
  } catch {
    return undefined
  }
  const moved = relocateJob(job, project)
  if (moved.length > 0) {
    repairWorktrees(project, moved)
    saveJob(project, job)
  }
  return job
}

// A path the job keeps inside its project's state directory, written while the project was somewhere else: the folder
// was renamed, moved or copied since. Only a whole string that is such a path counts, never one inside a text. A copy
// is rewritten too although the old path still exists: those worktrees belong to the original, not to this project.
function movedPath(value: string, project: string): string | undefined {
  if (!value.startsWith("/") || /\s/.test(value)) return undefined
  for (const dir of [DIR, LEGACY_DIR]) {
    const at = value.indexOf(`/${dir}/`)
    if (at < 0) continue
    const old = value.slice(0, at)
    if (old === project) return undefined
    return join(project, value.slice(at + 1))
  }
  return undefined
}

// Rewrites, in place, every path of the job that points into the state directory at the project's old place, so a
// renamed or moved project finds its worktrees again. Returns the rewritten paths that exist, for repairWorktrees.
export function relocateJob(job: Job, project: string): string[] {
  const found = new Set<string>()
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const next = movedPath(node, project)
      if (next === undefined) return node
      if (existsSync(next)) found.add(next)
      return next
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i])
      return node
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>
      for (const key of Object.keys(record)) record[key] = walk(record[key])
    }
    return node
  }
  walk(job)
  return [...found]
}

// Git links a worktree and its repository by absolute paths in both directions, so after the folder moved neither finds
// the other: the worktree says "not a git repository" and the repository lists it as prunable. `git worktree repair`
// with the worktrees' new paths, run in the moved checkout, rewrites both sides. Only directories that are worktrees
// (a .git file) are named; git ≥ 2.29 is enough.
export function repairWorktrees(project: string, paths: readonly string[]): boolean {
  const worktrees = paths.filter((path) => existsSync(join(path, ".git")))
  if (worktrees.length === 0 || !gitCommonDir(project)) return false
  try {
    execFileSync("git", ["worktree", "repair", ...worktrees], { cwd: project, timeout: 10_000, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

// Every job of the project, newest first.
export function listJobs(project: string): Job[] {
  const dir = jobsDir(project)
  if (!existsSync(dir)) return []
  const jobs: Job[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const job = loadJob(project, file.slice(0, -".json".length))
    if (job !== undefined) jobs.push(job)
  }
  // a job file without a created stamp is old data, not a crash: it sorts last.
  return jobs.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")))
}

// A job's fitness contract, next to the job and readable on its own (src/contract.ts): what "better" means is a
// decision worth reviewing, and its versions are the history of that decision.
export function saveContract(project: string, jobId: string, contract: { id: string; version: number }): string {
  const path = join(project, stateDir(project), "contracts", jobId, `${contract.id}.json`)
  atomicWrite(path, JSON.stringify(contract, null, 2) + "\n")
  return path
}

export function saveNote(project: string, jobId: string, taskId: string, text: string): string {
  const path = join(notesDir(project, jobId), `${taskId}.md`)
  atomicWrite(path, text)
  return path
}

// A job id that sorts by time and stays unique within a second: job-2026-10-04-143005-a1b2.
export function jobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  return `job-${stamp}-${Math.random().toString(16).slice(2, 6)}`
}
