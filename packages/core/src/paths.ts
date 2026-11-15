// The one place that answers "where does this live": a project's state directory, the user's state and the user's
// config. Packages ask here instead of spelling a directory name out, so a later move of the directories (design.md,
// the .opencode/omacode migration) changes one file rather than every caller.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Where jobs live: <project>/.micromanager/jobs/<id>.json. Inside the project, so workers can read their notes without
// an external_directory ask; kept out of git through the repository's own .git/info/exclude.
export const PROJECT_STATE = ".micromanager"
// The directory's name before 2026-10-19. A project that has it keeps using it: its jobs, notes and git worktrees live
// there, and moving a worktree under a running worker would pull the directory out from under it.
export const LEGACY_PROJECT_STATE = ".jev-micromanager"

// The project's state directory: the old one while the project has it and not the new one.
export function stateDir(project: string): string {
  return existsSync(join(project, LEGACY_PROJECT_STATE)) && !existsSync(join(project, PROJECT_STATE)) ? LEGACY_PROJECT_STATE : PROJECT_STATE
}

export function statePath(project: string, ...segments: string[]): string {
  return join(project, stateDir(project), ...segments)
}

// What was decided and measured: ${XDG_STATE_HOME:-~/.local/state}/micromanager, with decisions.jsonl and
// outcomes.jsonl. Per user, not per project, so a journal survives a fresh checkout.
export function userStateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "micromanager")
}

// OpenCode's own config directory. The plugins' files sit beside OpenCode's config, where the user already looks for
// settings, and OpenCode reads that directory itself.
export function userConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

export function userConfigPath(name: string): string {
  return join(userConfigDir(), name)
}
