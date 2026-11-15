// A1-T6: the plan boundary's guard on the tool calls themselves. Plan mode is a hard boundary (design.md, D10): the
// plan agent and the investigator it delegates to write only under <stateDir>/plan, and the obvious ways out of that
// directory in a shell command are refused before the command runs.
//
// This reads a path or a command, not what a program does. A shell line is not parsed: only the simple forms are seen
// (`cd ..`, `git checkout`, an absolute path spelled out), and the sandbox of A1-T7 is the barrier. What this adds is
// the cheap, readable refusal of the forms a model writes when it decides to change the project anyway.
//
// The target is resolved through the filesystem, not lexically: `realpath` of the nearest existing ancestor, with the
// part that does not exist yet appended in order. A symlink under the plan directory that points at the checkout is
// therefore seen for what it is, which a `resolve` would never show.

import { lstatSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"

import { statePath } from "@omacode/core/paths"

// The tools that name a file they change. A `patch` with only patch text names nothing here and is left to the
// permission layer; the paths a model writes are the ones this guard can read.
const WRITE_TOOLS = new Set(["edit", "write", "patch"])
const PATH_FIELDS = ["path", "filePath", "file", "filename"] as const
const PATH_LISTS = ["files", "paths"] as const

// A git subcommand that moves refs the user's own checkout shares. A plan reads the history; it never rewrites it.
const REFS = new Set(["checkout", "stash", "branch", "worktree", "config", "gc", "update-ref"])
// The git options that take the next word, so the subcommand is found past them ("git -C dir checkout main").
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"])
// Absolute paths that are not a place a command works in: the standard streams. Everything else absolute is checked,
// except the system temp directory, which is where a command writes its own scratch files.
const STREAMS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"])

export interface WriteGuardCall {
  readonly tool: string
  readonly input: Record<string, unknown>
}

export interface GuardScope {
  readonly root: string
  // Where a relative path resolves. Unset only for a caller that has no session directory; a plan agent then resolves
  // against the process's working directory, which is the project the plugin was loaded for.
  readonly directory?: string
}

export type Guarded =
  | { readonly ok: true; readonly advisory?: string }
  | { readonly ok: false; readonly reason: string; readonly message: string }

// An absolute path with every symlink along it resolved, including the ones in the part that does not exist yet:
// `realpath` of the nearest existing ancestor, and the missing tail appended in order. A link that cannot be followed
// (its target is missing) is treated as that ancestor: its own directory resolves and its name stays a name, so
// nothing is followed through it. Never throws.
export function realish(path: string): string {
  let current = resolve(path)
  const below: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return below.length ? join(real, ...below) : real
    } catch {
      // Not resolvable: missing, or a link whose target is missing.
    }
    let link = false
    try {
      link = lstatSync(current).isSymbolicLink()
    } catch {
      link = false
    }
    const parent = dirname(current)
    if (link) {
      let up = parent
      try {
        up = realpathSync(parent)
      } catch {
        // The root itself is unreadable: use it as it is rather than guess.
      }
      return join(up, basename(current), ...below)
    }
    if (parent === current) return join(current, ...below)
    below.unshift(basename(current))
    current = parent
  }
}

// Equals or lies under a resolved root, without a sibling whose name merely starts with the same characters:
// "/p/plan-old" is not "/p/plan".
export function insidePath(path: string, root: string): boolean {
  const p = resolve(path)
  const r = resolve(root)
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
}

// Where a plan lives: <project>/<stateDir>/plan (statePath answers the directory's name, old or new).
export function planRoot(project: string): string {
  return statePath(project, "plan")
}

// Every path a call names: the single-valued fields and the list-valued ones, in that order. Nothing else in an
// input is a path; an unknown shape names nothing and is left to the permission layer.
export function writePaths(call: WriteGuardCall): string[] {
  const out: string[] = []
  for (const field of PATH_FIELDS) {
    const value = call.input[field]
    if (typeof value === "string" && value.trim()) out.push(value)
  }
  for (const field of PATH_LISTS) {
    const value = call.input[field]
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item.trim()) out.push(item)
  }
  return out
}

// The guard itself: a pure answer for one call, so the hook stays a journal line and a throw. Nothing here blocks
// anything on its own; the caller turns `ok: false` into the tool's error and journals `advisory` without blocking.
export function writeGuard(call: WriteGuardCall, scope: GuardScope): Guarded {
  try {
    const root = realish(scope.root)
    const base = scope.directory === undefined ? undefined : realish(scope.directory)
    if (WRITE_TOOLS.has(call.tool)) return writes(call, root, base)
    if (call.tool === "shell") return shell(call, root, base)
    return { ok: true }
  } catch (err) {
    // A throw here would become the tool's error anyway, but with no reason the journal can read. Failing closed is
    // the boundary's rule (D10): a target this cannot resolve is refused, not waved through.
    return {
      ok: false,
      reason: "a target the plan guard could not read",
      message: `The plan guard could not read the target of this ${call.tool} call (${err instanceof Error ? err.message : String(err)}). Nothing was changed; use a path under the plan directory and say in the report what you wanted instead.`,
    }
  }
}

const refused = (reason: string, message: string): Guarded => ({ ok: false, reason, message })

function writes(call: WriteGuardCall, root: string, base: string | undefined): Guarded {
  const named = writePaths(call)
  // Fail closed: a patch whose targets are inside its text, or a write tool whose input this guard cannot read, names
  // no path it can check. Refusing is the boundary's rule; the message says which tool to use instead.
  if (named.length === 0) {
    return refused(
      `a ${call.tool} whose target cannot be read`,
      `This ${call.tool} call names no path this guard can check (the patch tool carries its targets inside the patch text). Plan mode changes nothing outside the plan directory, so it was refused; use edit or write with an explicit path under the plan directory.`,
    )
  }
  for (const path of named) {
    const expanded = homeward(path)
    const target = realish(isAbsolute(expanded) ? expanded : resolve(base ?? process.cwd(), expanded))
    if (!insidePath(target, root)) {
      return refused(
        "a write outside the plan root",
        `"${path}" resolves outside the plan directory (${root}). The project is read-only in plan mode, so this write was refused; write the plan and its artifacts under the plan directory, and say in the report what you wanted to change.`,
      )
    }
  }
  return { ok: true }
}

function shell(call: WriteGuardCall, root: string, base: string | undefined): Guarded {
  const command = typeof call.input.command === "string" ? call.input.command : ""
  if (!command.trim()) return { ok: true }
  const notes: string[] = []
  for (const words of segments(command)) {
    for (let i = 0; i < words.length; i++) {
      const word = opening(words[i]!)
      if (word === "cd") {
        const target = words[i + 1]
        // No argument goes home, `-` goes back to wherever the user was: both leave the plan root.
        if (target === undefined || target === "-" || climbsOrLeaves(target, root)) {
          return refused(
            "a cd that leaves the plan root",
            `"${command.trim()}" changes directory out of the plan directory (${root}). A command outside the plan root sees the user's own checkout, which plan mode changes nothing of; stay in the plan directory or report what you need.`,
          )
        }
        notes.push(`cd ${target} stays inside the plan directory`)
        continue
      }
      if (word === "git") {
        const sub = gitSubcommand(words, i + 1)
        if (sub !== undefined && REFS.has(sub)) {
          return refused(
            `git ${sub}`,
            `"git ${sub}" moves refs that the user's own checkout shares with this worktree, and a plan changes nothing of the project. Read the history instead (git log, git show, git status).`,
          )
        }
        continue
      }
      if (word === "rm") {
        const args = words.slice(i + 1).filter((w) => !w.startsWith("-"))
        if (args.some((arg) => climbsOrLeaves(arg, root))) {
          return refused(
            "an rm that leaves the plan root",
            `"${command.trim()}" deletes outside the plan directory (${root}). Files there belong to the project, which plan mode changes nothing of; delete only what the plan itself wrote.`,
          )
        }
        notes.push(`rm ${args.join(" ")} stays inside the plan directory, where deletion is allowed but not contained`)
        continue
      }
    }
    // Last, so a path that belongs to a refused `cd`, `rm` or git command is named by that clearer refusal above.
    for (const word of words) {
      for (const abs of absolutePaths(word)) {
        if (outside(abs, root, base)) {
          return refused(
            "an absolute path outside the plan root",
            `"${abs}" is outside the plan directory (${root}) and outside the session's own directory. A plan works in the plan directory; use a path there, or report what you need instead of reading or writing this one.`,
          )
        }
      }
    }
  }
  // The words this cannot read: it reads command text, not what a program does, so everything else is the sandbox's
  // (A1-T7) to hold. What is named here is journalled, not blocked.
  return notes.length ? { ok: true, advisory: notes.join("; ") } : { ok: true }
}

// A `~` is the user's home, which is outside the plan root and is refused by the same rule as any other outside path.
function homeward(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

// Whether a relative `cd`/`rm` argument climbs with `..`, or an absolute one points outside the root. A relative path
// without `..` stays where the command already is, so it cannot leave the root.
function climbsOrLeaves(word: string, root: string): boolean {
  const path = homeward(word)
  if (path.split("/").includes("..")) return true
  return isAbsolute(path) && !insidePath(realish(path), root)
}

// An absolute path outside the plan root and outside the session's own directory. The streams and the system temp
// directory are not places a command works in, so they are not refused.
function outside(path: string, root: string, base: string | undefined): boolean {
  if (!isAbsolute(path)) return false
  if (STREAMS.has(path)) return false
  const target = realish(path)
  if (insidePath(target, root)) return false
  if (base !== undefined && insidePath(target, base)) return false
  return !insidePath(target, realish(tmpdir()))
}

// The simple commands a shell joins with `&&`, `||`, `;`, `|` and a newline, each as its words. Quotes keep a path in
// one piece; a backslash escapes the next character. Not a parser: a substitution or a heredoc is left alone, and the
// sandbox is what catches those.
function segments(command: string): string[][] {
  const out: string[][] = []
  let current: string[] = []
  let word = ""
  let quoted: string | undefined
  let started = false
  const flush = () => {
    if (started) current.push(word)
    word = ""
    started = false
  }
  const next = () => {
    flush()
    if (current.length) out.push(current)
    current = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quoted !== undefined) {
      if (c === quoted) quoted = undefined
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quoted = c
      started = true
      continue
    }
    if (c === "\\") {
      i++
      if (i < command.length) {
        word += command[i]
        started = true
      }
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      flush()
      continue
    }
    if (c === "\n") {
      next()
      continue
    }
    if (c === ";" || c === "|" || c === "&") {
      next()
      if (command[i + 1] === c) i++
      continue
    }
    word += c
    started = true
  }
  next()
  return out
}

// A command name with a subshell's opening bracket in front of it: "(cd .." is a cd too.
function opening(word: string): string {
  return word.replace(/^[({]+/, "")
}

// The git subcommand, past the options that come before it. `-C <dir>` and the other value-taking options are
// stepped over with their value; anything else that starts with "-" is a flag on its own.
function gitSubcommand(words: readonly string[], from: number): string | undefined {
  for (let i = from; i < words.length; i++) {
    const word = words[i]!
    if (word === "--") return undefined
    if (word.startsWith("-")) {
      if (!word.includes("=") && GIT_VALUE_OPTS.has(word)) i++
      continue
    }
    return word
  }
  return undefined
}

// The absolute paths a word can name: the word itself, a redirection target ("2>/tmp/x"), and an option's value
// ("--out=/tmp/x").
function absolutePaths(word: string): string[] {
  const out: string[] = []
  let bare = word.replace(/^\d+(?=[<>])/, "")
  bare = bare.replace(/^[<>]+/, "")
  if (!bare) return out
  if (isAbsolute(bare)) out.push(bare)
  const eq = bare.indexOf("=")
  if (eq > 0) {
    const value = bare.slice(eq + 1)
    if (isAbsolute(value)) out.push(value)
  }
  return out
}
