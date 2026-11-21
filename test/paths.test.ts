import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  inStateDir,
  LEGACY_PROJECT_STATES,
  PROJECT_STATE,
  splitState,
  stateDir,
  statePath,
  userConfigDir,
  userConfigPath,
  userStateDir,
} from "../packages/core/src/paths.ts"

const [LEGACY_PROJECT_STATE, OLDEST_PROJECT_STATE] = LEGACY_PROJECT_STATES

test("stateDir keeps a project from before the rename on its old directory; everything else gets the new name", () => {
  const legacy = mkdtempSync(join(tmpdir(), "mm-legacy-"))
  const both = mkdtempSync(join(tmpdir(), "mm-both-"))
  const fresh = mkdtempSync(join(tmpdir(), "mm-fresh-"))
  try {
    mkdirSync(join(legacy, LEGACY_PROJECT_STATE, "jobs"), { recursive: true })
    assert.equal(stateDir(legacy), LEGACY_PROJECT_STATE)
    // Once the new directory exists the project is on it: an old one left behind does not win.
    mkdirSync(join(both, LEGACY_PROJECT_STATE))
    mkdirSync(join(both, PROJECT_STATE), { recursive: true })
    assert.equal(stateDir(both), PROJECT_STATE)
    assert.equal(stateDir(fresh), PROJECT_STATE)
    // Of two old ones, the newer name wins.
    mkdirSync(join(fresh, OLDEST_PROJECT_STATE))
    assert.equal(stateDir(fresh), OLDEST_PROJECT_STATE)
    mkdirSync(join(fresh, LEGACY_PROJECT_STATE))
    assert.equal(stateDir(fresh), LEGACY_PROJECT_STATE)
  } finally {
    for (const dir of [legacy, both, fresh]) rmSync(dir, { recursive: true, force: true })
  }
})

test("statePath joins under whichever state directory the project uses", () => {
  const legacy = mkdtempSync(join(tmpdir(), "mm-legacy-path-"))
  const fresh = mkdtempSync(join(tmpdir(), "mm-fresh-path-"))
  try {
    mkdirSync(join(legacy, LEGACY_PROJECT_STATE))
    assert.equal(statePath(legacy, "jobs", "job-1.json"), join(legacy, LEGACY_PROJECT_STATE, "jobs", "job-1.json"))
    assert.equal(statePath(fresh, "notes", "job-1", "T1.md"), join(fresh, PROJECT_STATE, "notes", "job-1", "T1.md"))
    assert.equal(statePath(fresh), join(fresh, PROJECT_STATE))
  } finally {
    for (const dir of [legacy, fresh]) rmSync(dir, { recursive: true, force: true })
  }
})

test("userStateDir follows XDG_STATE_HOME, and keeps the old name while only that exists", () => {
  const before = process.env.XDG_STATE_HOME
  try {
    const base = mkdtempSync(join(tmpdir(), "mm-user-state-"))
    process.env.XDG_STATE_HOME = base
    assert.equal(userStateDir(), join(base, "omacode"))
    mkdirSync(join(base, "micromanager"))
    assert.equal(userStateDir(), join(base, "micromanager"))
    mkdirSync(join(base, "omacode"))
    assert.equal(userStateDir(), join(base, "omacode"), "once the current one exists it wins")
    delete process.env.XDG_STATE_HOME
    assert.ok(userStateDir().startsWith(join(homedir(), ".local", "state")))
  } finally {
    if (before === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = before
  }
})

test("userConfigPath is <XDG_CONFIG_HOME>/opencode/<name>, or ~/.config/opencode/<name>", () => {
  const before = process.env.XDG_CONFIG_HOME
  try {
    const base = mkdtempSync(join(tmpdir(), "mm-user-config-"))
    process.env.XDG_CONFIG_HOME = base
    assert.equal(userConfigDir(), join(base, "opencode"))
    assert.equal(userConfigPath("micromanager.jsonc"), join(base, "opencode", "micromanager.jsonc"))
    delete process.env.XDG_CONFIG_HOME
    assert.equal(userConfigPath("guard.jsonc"), join(homedir(), ".config", "opencode", "guard.jsonc"))
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = before
  }
})

test("a path is split at its state directory under any name, and nothing else is", () => {
  assert.deepEqual(splitState(`/p/${PROJECT_STATE}/worktrees/job-1`), { project: "/p", dir: PROJECT_STATE, rest: "worktrees/job-1" })
  assert.deepEqual(splitState(`/p/q/${OLDEST_PROJECT_STATE}`), { project: "/p/q", dir: OLDEST_PROJECT_STATE, rest: "" })
  assert.deepEqual(splitState(`/p/${LEGACY_PROJECT_STATE}/worktrees/j/${PROJECT_STATE}/x`)?.dir, LEGACY_PROJECT_STATE, "the first one counts")
  assert.equal(splitState("/p/.opencode/agent/x.md"), undefined)
  assert.equal(inStateDir(`${PROJECT_STATE}/jobs/a.json`), true)
  assert.equal(inStateDir(`sub/${LEGACY_PROJECT_STATE}`), true)
  assert.equal(inStateDir(".opencode/agent/x.md"), false)
})
