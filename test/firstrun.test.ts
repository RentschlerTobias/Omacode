// C2-T7, the first run: the sample briefs, the folder the first deck goes to, the message the build agent gets, the
// engine check and the one-time offer. The dialogs themselves are in packages/tui/src/tui.tsx.

import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

import {
  BRIEFS,
  firstDeckDir,
  firstDeckPrompt,
  hyperframesInstalled,
  markOffered,
  MISSING_ENGINE,
  offeredPath,
  prepareFirstDeckDir,
  wasOffered,
} from "../packages/tui/src/firstrun.ts"

function tmp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "firstrun-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("three sample briefs, each with its own folder under omacode's data dir, never the home", (t) => {
  assert.equal(BRIEFS.length, 3)
  assert.equal(new Set(BRIEFS.map((b) => b.id)).size, 3)
  for (const b of BRIEFS) assert.match(b.id, /^[a-z0-9-]+$/)
  const data = tmp(t)
  const dirs = BRIEFS.map((b) => firstDeckDir(b, data))
  assert.deepEqual(dirs, BRIEFS.map((b) => join(data, "first-deck", b.id)))
  const made = prepareFirstDeckDir(dirs[0]!)
  assert.equal(statSync(made).isDirectory(), true)
  assert.equal(statSync(made).mode & 0o777, 0o700)
})

test("the build agent is told the steps: the deck skill, deck.json, make_artifact with present, and a plain explanation", () => {
  const brief = BRIEFS[0]!
  const text = firstDeckPrompt(brief)
  assert.ok(text.includes(brief.topic), "the topic")
  assert.match(text, /Read the deck skill/)
  assert.match(text, /deck\.json in the current directory/)
  assert.match(text, /reveals/)
  assert.match(text, /make_artifact \(spec: deck\.json, present: yes\)/)
  assert.match(text, /Never weaken a check/)
  assert.match(text, /plain words, without technical terms/)
  assert.match(text, /full folder path/)
  assert.match(text, /presenter's address/)
  // The agent may not call the deck good on its own say-so (the lesson of 2026-11-24).
  assert.match(text, /Do not say the deck looks good unless the presenter check passed/)
})

test("HyperFrames is found on PATH the way the runner finds it, and a missing one is named with its install", (t) => {
  const dir = tmp(t)
  assert.equal(hyperframesInstalled({ PATH: dir }), false)
  const bin = join(dir, "hyperframes")
  writeFileSync(bin, "#!/bin/sh\n")
  chmodSync(bin, 0o644)
  assert.equal(hyperframesInstalled({ PATH: dir }), false, "a file that is not executable is not an install")
  chmodSync(bin, 0o755)
  assert.equal(hyperframesInstalled({ PATH: `/nonexistent:${dir}` }), true)
  assert.match(MISSING_ENGINE, /install\.sh --with hyperframes/)
})

test("the first-start offer is made once, whatever the answer", (t) => {
  const state = tmp(t)
  const path = offeredPath(join(state, "omacode"))
  assert.equal(wasOffered(path), false)
  markOffered(path, new Date("2026-11-24T10:00:00Z"))
  assert.equal(wasOffered(path), true)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  // A file we cannot read was still written by us: no second offer.
  const broken = join(state, "broken.json")
  mkdirSync(state, { recursive: true })
  writeFileSync(broken, "{not json")
  assert.equal(wasOffered(broken), true)
})
