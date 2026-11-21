// The one place that answers "where does this live": a project's state directory, the user's state and the user's
// config. Packages ask here instead of spelling a directory name out, so a later move of the directories (design.md,
// the .opencode/omacode migration) changes one file rather than every caller.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// Where jobs live: <project>/.opencode/omacode/jobs/<id>.json. Inside the project, so workers can read their notes
// without an external_directory ask; inside OpenCode's own directory, since it is OpenCode's state with a plugin; kept
// out of git through the repository's own .git/info/exclude.
//
// What that costs (checked 2026-11-21, OpenCode 2.2.5): OpenCode loads nothing below it as an agent, command, mode or
// plugin and reloads no config when it changes, but it watches .opencode/ recursively, so every directory of a worktree
// here holds one inotify watch (node_modules, .git, .venv and __pycache__ excepted). And a session inside a worktree
// reads every opencode.json above it: nothing may write one into the state directory.
export const PROJECT_STATE = ".opencode/omacode"
// Its names before, newest first: .micromanager (until 2026-11-21) and .jev-micromanager (until 2026-10-19). A
// project that has one keeps using it until `migrate` moves it: its jobs, notes and git worktrees live there, and moving
// a worktree under a running worker would pull the directory out from under it.
export const LEGACY_PROJECT_STATES = [".micromanager", ".jev-micromanager"] as const
// Every name the state directory has had, the current one first: what a path is matched against.
export const STATE_DIRS: readonly string[] = [PROJECT_STATE, ...LEGACY_PROJECT_STATES]

// The project's state directory: the current one when the project has it, else an old one it still has, else the
// current one for a project that has none yet.
export function stateDir(project: string): string {
  if (existsSync(join(project, PROJECT_STATE))) return PROJECT_STATE
  return LEGACY_PROJECT_STATES.find((old) => existsSync(join(project, old))) ?? PROJECT_STATE
}

export function statePath(project: string, ...segments: string[]): string {
  return join(project, stateDir(project), ...segments)
}

// Whether a project-relative path ("a/b", no leading slash) is a state directory or lies inside one, under any name.
export function inStateDir(rel: string): boolean {
  const path = rel.replace(/\/+$/, "")
  return STATE_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`) || path.endsWith(`/${dir}`) || path.includes(`/${dir}/`))
}

// Splits an absolute path at the first state directory in it, under any name: the project before it, the state
// directory's name, and the rest after it ("" for the directory itself). undefined for a path outside every one.
export function splitState(path: string): { project: string; dir: string; rest: string } | undefined {
  let best: { project: string; dir: string; rest: string } | undefined
  let bestAt = Infinity
  for (const dir of STATE_DIRS) {
    const inner = path.indexOf(`/${dir}/`)
    const at = inner >= 0 ? inner : path.endsWith(`/${dir}`) ? path.length - dir.length - 1 : -1
    if (at < 0 || at >= bestAt) continue
    bestAt = at
    best = { project: path.slice(0, at) || "/", dir, rest: path.slice(at + dir.length + 2) }
  }
  return best
}

// The user's own directories, per user and not per project: ${XDG_STATE_HOME:-~/.local/state}/omacode for what was
// decided and measured (decisions.jsonl, outcomes.jsonl, the vault, the context state, held-out cases) and
// ${XDG_DATA_HOME:-~/.local/share}/omacode for what is kept (the memory). Their name until 2026-11-21 was micromanager;
// a user who has only the old one keeps using it until `migrate --user` moves it.
export const USER_DIR = "omacode"
export const LEGACY_USER_DIRS = ["micromanager"] as const

function xdg(variable: "XDG_STATE_HOME" | "XDG_DATA_HOME", fallback: string): string {
  return process.env[variable] || join(homedir(), ".local", fallback)
}

// The current name when it exists, else an old one that exists, else the current one: the same rule as stateDir.
function current(base: string, name: string, legacy: readonly string[]): string {
  if (existsSync(join(base, name))) return join(base, name)
  const old = legacy.find((n) => existsSync(join(base, n)))
  return join(base, old ?? name)
}

export function userStateBase(): string {
  return xdg("XDG_STATE_HOME", "state")
}

export function userDataBase(): string {
  return xdg("XDG_DATA_HOME", "share")
}

export function userStateDir(): string {
  return current(userStateBase(), USER_DIR, LEGACY_USER_DIRS)
}

export function userDataDir(): string {
  return current(userDataBase(), USER_DIR, LEGACY_USER_DIRS)
}

// The micromanager's mode per session (src/mode.ts writes it, the TUI reads it as a badge): plan is the default, and
// leaving it takes the user's own answer.
export function modesPath(): string {
  return join(userStateDir(), "modes.json")
}

// OpenCode's own config directory. The plugins' files sit beside OpenCode's config, where the user already looks for
// settings, and OpenCode reads that directory itself.
export function userConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

export function userConfigPath(name: string): string {
  return join(userConfigDir(), name)
}

// The plugin's settings file and the TUI's model picks, beside OpenCode's config. Old names, newest first, are read
// while the current one does not exist: micromanager.jsonc until 2026-11-21, jev-micromanager.jsonc until 2026-10-19.
export const CONFIG_FILE = "omacode.jsonc"
export const LEGACY_CONFIG_FILES = ["micromanager.jsonc", "jev-micromanager.jsonc"] as const
export const PICKS_FILE = "omacode-models.json"
export const LEGACY_PICKS_FILES = ["micromanager-models.json"] as const

// The settings file in a directory (the user's config directory by default, or a project's .opencode/).
export function configFilePath(dir = userConfigDir()): string {
  return current(dir, CONFIG_FILE, LEGACY_CONFIG_FILES)
}

export function picksFilePath(dir = userConfigDir()): string {
  return current(dir, PICKS_FILE, LEGACY_PICKS_FILES)
}

// The settings file's name as the user should edit it, for messages ("budget" in omacode.jsonc).
export function configFileName(): string {
  return basename(configFilePath())
}
