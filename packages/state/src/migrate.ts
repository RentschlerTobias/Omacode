// Moving a project's state directory from an old name (LEGACY_PROJECT_STATES) to the current one, PROJECT_STATE
// (core/paths.ts; roadmap A5-T3). A dry run says what would move; --apply moves it. Nothing is linked back: a project
// that is not migrated keeps working on its old directory, and the plugin says once per session that it could move.
//
// The move is one rename of the whole directory, so jobs, notes, plans, backlog, contracts and worktrees go together.
// Afterwards every path a job keeps is rewritten to the new place and git's links of the worktrees are repaired, the
// same way as after a renamed project folder (store.ts relocateJob, repairWorktrees).

import { execFileSync } from "node:child_process"
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  CONFIG_FILE, LEGACY_CONFIG_FILES, LEGACY_PICKS_FILES, LEGACY_PROJECT_STATES, LEGACY_USER_DIRS, PICKS_FILE, PROJECT_STATE, splitState,
  USER_DIR, userConfigDir, userDataBase, userStateBase,
} from "@omacode/core/paths"
import { excludeFromGit, gitCommonDir } from "@omacode/core/project"

import type { Job } from "./state.ts"
import { listJobs, repairWorktrees } from "./store.ts"

// A task in one of these is being worked on: its worker's directory would vanish under it.
const BUSY = new Set(["running", "gating", "reviewing", "fixing"])

export interface MigrationPlan {
  readonly project: string
  readonly from?: string // the old directory's name, when there is one to move
  readonly to: string
  readonly jobs: number
  readonly worktrees: readonly string[] // registered worktrees inside the old directory, at their new place
  readonly problems: readonly string[] // why it cannot move now; empty when it can
  readonly note: string // what happens, in one or two sentences
}

// git's registered worktrees inside a state directory of this name, wherever the project was when git recorded them
// (a project moved before its migration still has the old place in git's records), as paths in the new directory.
function worktreesIn(project: string, from: string, to: string): string[] {
  if (!gitCommonDir(project)) return []
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: project, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
    return out.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length).trim())
      .flatMap((path) => {
        const at = splitState(path)
        return at && at.dir === from && at.rest ? [join(project, to, at.rest)] : []
      })
  } catch {
    return []
  }
}

function busyJobs(jobs: readonly Job[]): string[] {
  return jobs.filter((job) => (job.tasks ?? []).some((task) => BUSY.has(task.status))).map((job) => job.id)
}

export function planMigration(project: string): MigrationPlan {
  const to = PROJECT_STATE
  const present = LEGACY_PROJECT_STATES.filter((old) => existsSync(join(project, old)))
  const hasNew = existsSync(join(project, to))
  if (present.length === 0) {
    return { project, to, jobs: 0, worktrees: [], problems: [], note: hasNew ? `already on ${to}; nothing to move` : "no state directory yet; a first job creates it under its current name" }
  }
  const problems: string[] = []
  // Two places with state would be two sets of jobs: the user decides which one counts, nothing is merged.
  if (hasNew) problems.push(`${to} exists already next to ${present.join(" and ")}; move or delete one by hand, nothing is merged`)
  if (present.length > 1) problems.push(`both ${present.join(" and ")} exist; move or delete one by hand, nothing is merged`)
  const from = present[0]!
  const old = join(project, from)
  // Jobs are read from the old directory as it is, without the relocation a load would do.
  const jobs = existsSync(join(old, "jobs")) ? readdirSync(join(old, "jobs")).filter((f) => f.endsWith(".json")).length : 0
  const busy = hasNew || present.length > 1 ? [] : busyJobs(listJobs(project))
  if (busy.length) problems.push(`${busy.length === 1 ? "job" : "jobs"} ${busy.join(", ")} still ${busy.length === 1 ? "has a task" : "have tasks"} at work; let ${busy.length === 1 ? "it" : "them"} finish or stop ${busy.length === 1 ? "it" : "them"} first`)
  const worktrees = worktreesIn(project, from, to)
  const note = `moves ${from}/ to ${to}/ (${jobs} job${jobs === 1 ? "" : "s"}, ${worktrees.length} git worktree${worktrees.length === 1 ? "" : "s"}), rewrites the jobs' paths and repairs the worktrees. Close OpenCode sessions that work in one of those worktrees first: their directory moves.`
  return { project, from, to, jobs, worktrees, problems, note }
}

export interface MigrationResult {
  readonly moved: boolean
  readonly jobs: number
  readonly repaired: boolean
  readonly text: string
}

export function applyMigration(plan: MigrationPlan): MigrationResult {
  if (!plan.from) return { moved: false, jobs: 0, repaired: false, text: plan.note }
  if (plan.problems.length) return { moved: false, jobs: 0, repaired: false, text: `nothing moved: ${plan.problems.join("; ")}` }
  const target = join(plan.project, plan.to)
  mkdirSync(dirname(target), { recursive: true })
  renameSync(join(plan.project, plan.from), target)
  // A load rewrites each job's paths to the new place, repairs the worktrees it names and saves the job.
  const jobs = listJobs(plan.project).length
  // Worktrees no job names any more (a leftover of an interrupted run) are relinked too, so git does not prune them.
  const repaired = repairWorktrees(plan.project, plan.worktrees)
  excludeFromGit(plan.project)
  return { moved: true, jobs, repaired, text: `moved ${plan.from}/ to ${plan.to}/: ${jobs} job${jobs === 1 ? "" : "s"}, ${plan.worktrees.length} worktree${plan.worktrees.length === 1 ? "" : "s"} relinked` }
}

// The user's own directories and settings files: ~/.local/state/micromanager, ~/.local/share/micromanager (the memory),
// micromanager.jsonc and micromanager-models.json beside OpenCode's config, each to its current name (core/paths.ts).
export interface UserMove {
  readonly what: string
  readonly from: string
  readonly to: string
}

export interface UserMigrationPlan {
  readonly moves: readonly UserMove[]
  readonly problems: readonly string[]
  readonly warnings: readonly string[]
}

function oldOne(base: string, legacy: readonly string[]): string | undefined {
  const found = legacy.find((name) => existsSync(join(base, name)))
  return found ? join(base, found) : undefined
}

export function planUserMigration(): UserMigrationPlan {
  const moves: UserMove[] = []
  const problems: string[] = []
  const items: { what: string; base: string; name: string; legacy: readonly string[] }[] = [
    { what: "state (journal, vault, context, held-out cases)", base: userStateBase(), name: USER_DIR, legacy: LEGACY_USER_DIRS },
    { what: "data (memory, services, tools)", base: userDataBase(), name: USER_DIR, legacy: LEGACY_USER_DIRS },
    { what: "settings", base: userConfigDir(), name: CONFIG_FILE, legacy: LEGACY_CONFIG_FILES },
    { what: "model picks", base: userConfigDir(), name: PICKS_FILE, legacy: LEGACY_PICKS_FILES },
  ]
  for (const item of items) {
    const from = oldOne(item.base, item.legacy)
    if (!from) continue
    const to = join(item.base, item.name)
    if (existsSync(to)) problems.push(`${item.what}: both ${from} and ${to} exist; move or delete one by hand, nothing is merged`)
    else moves.push({ what: item.what, from, to })
  }
  const warnings: string[] = []
  try {
    execFileSync("pgrep", ["-x", "opencode"], { stdio: "ignore", timeout: 3000 })
    warnings.push("OpenCode is running: quit it first, so nothing writes to the old places while they move")
  } catch {
    // not running, or no pgrep: nothing to say
  }
  return { moves, problems, warnings }
}

// What else names a moved directory by its absolute path: the unit files of omacode-services and the directory of
// the user's command links (~/.local/bin/hyperframes points into the data directory's tools/).
export interface Outside {
  readonly files?: readonly string[]
  readonly binDir?: string
}

export function applyUserMigration(plan: UserMigrationPlan, outside: Outside = {}): { moved: number; text: string } {
  if (plan.problems.length) return { moved: 0, text: `nothing moved: ${plan.problems.join("; ")}` }
  const lines: string[] = []
  for (const move of plan.moves) {
    mkdirSync(dirname(move.to), { recursive: true })
    renameSync(move.from, move.to)
    lines.push(`moved ${move.what}: ${move.from} → ${move.to}`)
    for (const fixed of rehome(move.from, move.to, outside)) lines.push(`  rewrote ${fixed}`)
  }
  return { moved: plan.moves.length, text: lines.length ? lines.join("\n") : "nothing to move" }
}

// After a directory moved: every file that names it by its old absolute path, rewritten to the new one. Inside it,
// the Python environments of the services and the tools (pyvenv.cfg, the scripts in bin/ with their #! line, the .pth
// files of an editable install) and the services' config.json; outside it, the given files and the links in binDir.
// Only text files are touched, and only the old path as a whole path (followed by /, a quote, white space or the end).
export function rehome(from: string, to: string, outside: Outside = {}): string[] {
  const old = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/"'\\s]|$)`, "g")
  const fixed: string[] = []
  const rewrite = (file: string) => {
    try {
      const st = lstatSync(file)
      if (!st.isFile() || st.size > 4 * 1024 * 1024 || binary(file)) return
      const text = readFileSync(file, "utf8")
      const next = text.replace(old, to)
      if (next === text) return
      writeFileSync(file, next, { mode: st.mode })
      fixed.push(file)
    } catch {
      // unreadable or gone: nothing to rewrite
    }
  }
  for (const venv of venvs(to)) {
    rewrite(join(venv, "pyvenv.cfg"))
    for (const f of list(join(venv, "bin"))) rewrite(join(venv, "bin", f))
    for (const py of list(join(venv, "lib")).filter((d) => d.startsWith("python"))) {
      const site = join(venv, "lib", py, "site-packages")
      for (const f of list(site).filter((x) => x.endsWith(".pth"))) rewrite(join(site, f))
    }
  }
  rewrite(join(to, "services", "config.json"))
  for (const f of outside.files ?? []) rewrite(f)
  if (outside.binDir) {
    for (const name of list(outside.binDir)) {
      const link = join(outside.binDir, name)
      try {
        if (!lstatSync(link).isSymbolicLink()) continue
        const target = readlinkSync(link)
        if (target !== from && !target.startsWith(`${from}/`)) continue
        unlinkSync(link)
        symlinkSync(to + target.slice(from.length), link)
        fixed.push(link)
      } catch {
        // a link that went away meanwhile
      }
    }
  }
  return fixed
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// A NUL in the first 4 KB: a compiled file, left alone.
function binary(file: string): boolean {
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

// The Python environments under a directory: each one a directory holding pyvenv.cfg, at most four levels down, not
// inside what holds data rather than programs (a ComfyUI's models or outputs, node_modules, git).
const SKIP = new Set(["node_modules", ".git", "models", "output", "input", "custom_nodes", "memory", "__pycache__"])
function venvs(root: string, depth = 0): string[] {
  if (depth > 4) return []
  if (existsSync(join(root, "pyvenv.cfg"))) return [root]
  const out: string[] = []
  for (const name of list(root)) {
    if (SKIP.has(name)) continue
    const dir = join(root, name)
    try {
      if (lstatSync(dir).isDirectory()) out.push(...venvs(dir, depth + 1))
    } catch {
      // gone meanwhile
    }
  }
  return out
}
