// The micromanager's mode (src/mode.ts): one agent, two modes. Plan is the default, so a new session plans instead of
// starting work; leaving plan mode takes the user's own turn after the question was put, never the agent's word.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import { askToLeave, canLeave, clearAsk, forgetModes, loadModes, modeOf, noteUserSpoke, setMode } from "../packages/micromanager/src/mode.ts"

// modesPath() reads XDG_STATE_HOME when it is called, so setting it here, before any call, is enough.
const home = mkdtempSync(join(tmpdir(), "mm-mode-"))
process.env.XDG_STATE_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

test("plan is the default: a session that never chose is planning", () => {
  forgetModes()
  assert.equal(modeOf("ses_new"), "plan")
  assert.equal(modeOf(undefined), "plan")
})

test("a mode survives a restart", () => {
  forgetModes()
  setMode("ses_a", "build")
  const file = join(home, "micromanager", "modes.json")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ses_a: "build" }, "the mode is on disk")
  forgetModes()
  loadModes()
  assert.equal(modeOf("ses_a"), "build", "and comes back after a restart")
  assert.equal(modeOf("ses_b"), "plan", "while a new session still plans")
})

test("leaving plan mode needs a user turn after the question", () => {
  forgetModes()
  setMode("ses_c", "plan")
  noteUserSpoke("ses_c") // the message that led to the question
  askToLeave("ses_c")
  assert.equal(canLeave("ses_c"), false, "the turn that caused the question does not count")
  noteUserSpoke("ses_c") // the user's answer
  assert.equal(canLeave("ses_c"), true, "their next turn unlocks it")
  clearAsk("ses_c")
  assert.equal(canLeave("ses_c"), false, "and the unlock is used once")
})

test("a session that was never asked cannot leave", () => {
  forgetModes()
  noteUserSpoke("ses_d")
  assert.equal(canLeave("ses_d"), false, "no question, no switch")
})
