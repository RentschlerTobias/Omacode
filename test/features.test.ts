// The installer behind install_feature, /setup and the welcome (features.ts): what it says, and that without sudo a
// system package is named for the terminal and nothing is run. The agent's hints when a part is missing (setup.ts).

import assert from "node:assert/strict"
import { test } from "node:test"

import { installParts, outcomeText } from "../packages/micromanager/src/features.ts"
import { missingForKind, missingNote, type Present } from "../packages/micromanager/src/setup.ts"
import type { Exec } from "../packages/micromanager/src/worktree/git.ts"

const never: Exec = async () => {
  throw new Error("nothing may run here")
}

const present = (over: Partial<Present> = {}): Present => ({ services: true, chromium: false, tools: [], which: () => undefined, ...over })

test("without sudo a system package is named for the user's terminal, and nothing runs", async () => {
  const lines: string[] = []
  const outcome = await installParts(["chromium"], { run: never, log: (l) => lines.push(l), there: present() })
  assert.equal(outcome.installed.length, 0)
  assert.ok(outcome.terminal, "the command for the terminal")
  assert.match(outcome.terminal!, /chromium/)
  assert.match(outcomeText(outcome), /Needs sudo, so the user runs this in a terminal: .*chromium/)
  assert.ok(lines.some((l) => /needs your terminal/.test(l)))
})

test("a part already there is reported, not installed", async () => {
  const outcome = await installParts(["services"], { run: never, log: () => undefined, there: present({ services: true }) })
  assert.deepEqual(outcome, { ok: true, installed: [], present: ["Local services"], failed: [] })
  assert.equal(outcomeText(outcome), "Already there: Local services.")
})

test("a deck or a video names what it needs; sites and images have fallbacks and are not blocked", () => {
  const none = () => undefined
  assert.deepEqual(missingForKind("deck", none), ["hyperframes"])
  assert.deepEqual(missingForKind("video", none), ["hyperframes", "ffmpeg"])
  assert.deepEqual(missingForKind("video", (n) => (n === "hyperframes" ? "/x/hyperframes" : undefined)), ["ffmpeg"])
  assert.deepEqual(missingForKind("site", none), [])
  assert.deepEqual(missingForKind("images", none), [])
  const note = missingNote("This video", ["hyperframes", "ffmpeg"])
  assert.match(note, /call install_feature with part "hyperframes"/)
  assert.match(note, /ask the user whether to install it/)
  assert.match(note, /ffmpeg .* is a system package: ask the user to run \.\/install\.sh --with ffmpeg/)
})

test("Manim brings the libraries it is built against; without sudo it waits for them instead of failing halfway", async () => {
  const { planFor } = await import("../packages/micromanager/src/setup.ts")
  const bare = present({ which: (n) => (n === "uv" ? "/usr/bin/uv" : undefined) })
  assert.deepEqual(planFor(["manim"], bare).system, ["cairo-build"])
  assert.deepEqual(planFor(["manim"], present({ which: (n) => (["uv", "pkg-config"].includes(n) ? `/usr/bin/${n}` : undefined) })).system, [], "a machine with pkg-config has the libraries")
  const outcome = await installParts(["manim"], { run: never, log: () => undefined, there: bare })
  assert.match(outcome.terminal ?? "", /cairo/)
  assert.deepEqual(outcome.installed, [])
  assert.match(outcome.failed.join(), /Manim \(needs its system libraries first\)/)
})
