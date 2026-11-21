// What a project is, independent of where its folder happens to be: the project a directory belongs to (a session in
// one of its worktrees belongs to the project, not to the worktree), an id that survives renaming or moving the folder,
// and the repository's local exclude file that keeps the state directory out of git.
//
// Everything the plugins keep about a project outside of it (its memory, its held-out cases) is keyed by that id, never
// by the folder's path: a key made from the path made the project a stranger to its own memory after every rename.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, sep } from "node:path"

import { LEGACY_PROJECT_STATE, PROJECT_STATE, stateDir } from "./paths.ts"

// The file that holds the project's id, in its state directory, so it moves with the folder.
export const PROJECT_FILE = "project.json"

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// The project a directory belongs to: a worktree or plan area lies inside <project>/<state dir>/, so everything from the
// first state directory segment on is cut off. Any other directory is its own project.
export function projectRoot(dir: string): string {
  const parts = dir.split(sep)
  const at = parts.findIndex((part, i) => i > 0 && (part === PROJECT_STATE || part === LEGACY_PROJECT_STATE))
  return at > 0 ? parts.slice(0, at).join(sep) || sep : dir
}

// The key projects had before they had an id: the folder's name and a short hash of its path. Still the id a project
// gets when it is first given one, so the memory it already has stays its own.
export function pathSlug(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"
  return `${name}-${createHash("sha256").update(dir).digest("hex").slice(0, 6)}`
}

function readId(root: string): string | undefined {
  const path = join(root, stateDir(root), PROJECT_FILE)
  if (!existsSync(path)) return undefined
  try {
    const id = (JSON.parse(readFileSync(path, "utf8")) as { id?: unknown }).id
    return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

export interface ProjectIdOptions {
  // Write the id file when the project has none yet. A function decides from the id the project would get: the memory
  // asks "is anything kept under it?", so a folder that was only looked at is not given a state directory.
  readonly create?: boolean | ((id: string) => boolean)
}

// The project's id: from its id file, else the path slug, which is written as its id when `create` says so. Without the
// file the id still depends on the path, so whatever keeps something about a project should create it.
export function projectId(dir: string, options: ProjectIdOptions = {}): string {
  const root = projectRoot(dir)
  const found = readId(root)
  if (found) return found
  const id = pathSlug(root)
  const create = typeof options.create === "function" ? options.create(id) : options.create === true
  if (create) {
    try {
      atomicWrite(join(root, stateDir(root), PROJECT_FILE), `${JSON.stringify({ id, created: new Date().toISOString() }, null, 2)}\n`)
      excludeFromGit(root)
    } catch {
      // A read-only folder keeps working under its path slug, as before.
    }
  }
  return id
}

// The git directory that holds the shared state of the repository: <project>/.git for a plain checkout, the main
// repository's .git for a worktree. Git answers relative to the cwd it ran in, so a relative answer is resolved
// against the project. Anything git cannot answer (no repository, git missing, timeout) means "not a repository".
export function gitCommonDir(project: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: project,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (!out) return undefined
    return isAbsolute(out) ? out : join(project, out)
  } catch {
    return undefined
  }
}

// Adds the state directory (the current one or the legacy one, stateDir) to the repository's local exclude file once;
// a directory that is no git repository is left alone.
// The job state and the project memory (.opencode/memory/, opencode-agent-memory's place) stay out of git.
//
// The exclude file belongs to the repository, not to the project: a project is often a subdirectory of a monorepo, where
// <project>/.git does not exist at all, and a worktree checkout keeps it outside the project as well. Asking git is the
// only way to find it; guessing left a real run with the state directory untracked in git status and nothing said so.
export function excludeFromGit(project: string): boolean {
  const common = gitCommonDir(project)
  if (!common) return false
  // atomicWrite creates the directory: a bare or hand-made repo can lack .git/info entirely.
  const exclude = join(common, "info", "exclude")
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
  // The backlog and the contracts are the user's to commit (design.md §25); everything else in the state directory
  // stays out. A bare "<dir>/" line from before would hide them, and git cannot re-include a file below an excluded
  // directory, so that line is replaced rather than added to. "**/": a pattern with a slash in it is anchored at the
  // repository root, and the project is often a subdirectory of it.
  const dir = stateDir(project)
  const lines = before.split("\n").filter((line) => line.trim() !== `${dir}/` && line.trim() !== dir)
  while (lines.length && lines.at(-1) === "") lines.pop()
  for (const entry of [`**/${dir}/*`, `!**/${dir}/backlog/`, `!**/${dir}/contracts/`, ".opencode/memory/"]) {
    if (!lines.some((line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""))) lines.push(entry)
  }
  const after = `${lines.join("\n")}\n`
  if (after !== before) atomicWrite(exclude, after)
  return true
}
