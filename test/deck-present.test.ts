// The deck as the person presenting sees it (2026-11-24). Every older deck check passed on a deck whose presenter drew
// all slides on top of each other: `hyperframes present` serves the page as written and its player adds no runtime to a
// deck with inline scenes. These tests pin the two halves of the fix: the project carries the runtime for the presenter
// (and only there) with explicit slide windows and reveal lines, and deck.present fails what the probe saw in the
// broken presenter. test/deck.test.ts runs the real engine and the probe end to end.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

import {
  DECK_CHECKS,
  DECK_RUNTIME,
  deckResults,
  writeDeckProject,
  type DeckPresentReport,
} from "../packages/artifact/src/adapters/deck.ts"
import type { CheckResult } from "../packages/artifact/src/checks.ts"
import { parseSpec, type DeckSpec } from "../packages/artifact/src/spec.ts"

function jobFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "deck-present-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, "job")
}

function deckOf(slides: readonly Record<string, unknown>[]): DeckSpec {
  const parsed = parseSpec("deck", { kind: "deck", version: 2, job: "t", brief: "a test", slides })
  assert.deepEqual(parsed.errors, [])
  return parsed.spec as DeckSpec
}

const resultOf = (results: readonly CheckResult[], id: string): CheckResult => {
  const found = results.find((r) => r.id === id)
  assert.ok(found, `no result for ${id}`)
  return found
}

const report = (steps: DeckPresentReport["steps"], extra: Partial<DeckPresentReport> = {}): DeckPresentReport => ({
  url: "http://127.0.0.1:3904/",
  errors: [],
  scenes: 2,
  steps,
  shots: [],
  ...extra,
})

test("deck.present fails a presenter that stacks the slides, and passes one that shows them one at a time", (t) => {
  const spec = deckOf([
    { id: "a", title: "A", body: "first", notes: "n" },
    { id: "b", title: "B", body: "second", notes: "n" },
  ])
  const project = writeDeckProject(spec, jobFor(t))
  const verdict = (input: Partial<Parameters<typeof deckResults>[0]>) =>
    resultOf(deckResults({ spec, project, ...input }, DECK_CHECKS), "deck.present")

  // What the probe saw in the deck the user caught: both slides on stage at every step, and the slideshow's complaint.
  const stacked = verdict({
    present: report(
      [
        { expected: "a", stop: 0, visible: ["a", "b"], titleOpacity: 1 },
        { expected: "b", stop: 0, visible: ["a", "b"], titleOpacity: 1 },
      ],
      {
        scenes: 0,
        errors: ["error: [hyperframes-slideshow] no main-line slides resolved"],
        problem: "the player reported no scenes within 20 s, so the slideshow had nothing to step through",
      },
    ),
  })
  assert.equal(stacked.status, "failed")
  assert.match(stacked.reason ?? "", /reported no scenes/)
  assert.match(stacked.reason ?? "", /1 console error: error: \[hyperframes-slideshow\] no main-line slides resolved/)
  assert.match(stacked.reason ?? "", /2 slides on stage at a: a, b/)

  const wrong = verdict({
    present: report([
      { expected: "a", stop: 0, visible: ["a"], titleOpacity: 1 },
      { expected: "b", stop: 0, visible: ["a"], titleOpacity: 1 },
    ]),
  })
  assert.equal(wrong.status, "failed")
  assert.match(wrong.reason ?? "", /a was on stage at b/)

  const unseen = verdict({
    present: report([
      { expected: "a", stop: 0, visible: ["a"], titleOpacity: 0 },
      { expected: "b", stop: 0, visible: ["b"], titleOpacity: 1 },
    ]),
  })
  assert.match(unseen.reason ?? "", /the title is not shown at a \(opacity 0\.00\)/)

  const short = verdict({ present: report([{ expected: "a", stop: 0, visible: ["a"], titleOpacity: 1 }]) })
  assert.match(short.reason ?? "", /stepped through 1 slide, the deck has 2/)

  const clean = verdict({
    present: report([
      { expected: "a", stop: 0, visible: ["a"], titleOpacity: 1 },
      { expected: "b", stop: 0, visible: ["b"], titleOpacity: 1 },
    ]),
  })
  assert.equal(clean.status, "passed")
  assert.equal(clean.output, "2 slides in 2 steps, one slide on stage at each, no console error")

  // No browser is a skip with its reason; a probe that broke, or no report at all, is a failure and never a pass.
  const skip = verdict({ presentSkip: "no browser is installed where the plugin runs" })
  assert.equal(skip.status, "skipped")
  assert.equal(skip.reason, "no browser is installed where the plugin runs")
  assert.equal(verdict({ presentProblem: "spawn EACCES" }).status, "failed")
  assert.equal(verdict({}).status, "failed")
  assert.equal(DECK_CHECKS.find((def) => def.id === "deck.present")?.skippable, true)
})

test("a project carries the runtime for the presenter only, names each slide's window, and marks revealed lines", (t) => {
  const job = jobFor(t)
  const runtime = join(job, "..", "runtime.js")
  writeFileSync(runtime, "window.__player = {}\n")
  const spec = deckOf([{ id: "s1", title: "Steps", body: "always\nlater\nlast", notes: "n", reveals: [2, 1] }])
  const project = writeDeckProject(spec, job, { runtime })

  assert.deepEqual(project.files, ["index.html", "hyperframes.json", "meta.json", DECK_RUNTIME])
  assert.equal(readFileSync(join(job, DECK_RUNTIME), "utf8"), "window.__player = {}\n")
  assert.equal(statSync(join(job, DECK_RUNTIME)).mode & 0o777, 0o600)

  const html = readFileSync(join(job, "index.html"), "utf8")
  // No static <script src> for the runtime: the lint reads every local script, and a render brings its own runtime.
  assert.doesNotMatch(html, /^\s*<script src="hyperframe\.runtime\.iife\.js"/m)
  // The loader writes it only inside the presenter, behind the same guard as the motion.
  assert.ok(html.includes('querySelector("hyperframes-slideshow")'), "the presenter guard")
  assert.ok(html.includes(`document.write('<script src="${DECK_RUNTIME}"><\\/script>')`), "the presenter-only loader")

  // The window is written out, and two reveals are three stops: the slide alone, then each revealed line in turn.
  const slide = (project.island.slides as readonly { startTime: number; endTime: number; fragments: readonly number[] }[])[0]
  assert.deepEqual([slide?.startTime, slide?.endTime], [0, 8])
  assert.deepEqual(slide?.fragments, [1.333, 4, 6.667])
  assert.match(html, /<p>always<\/p>\s*<p data-reveal-at="4">later<\/p>\s*<p data-reveal-at="6.667">last<\/p>/)

  // Without a runtime there is no loader line and no copy; the motion guard is still there.
  const bare = writeDeckProject(spec, join(job, "bare"))
  assert.equal(bare.files.includes(DECK_RUNTIME), false)
  assert.equal(readFileSync(join(job, "bare", "index.html"), "utf8").includes("document.write"), false)
})

test("the deck skill's example spec is a spec the parser accepts", () => {
  // A first-run agent wrote a deck without job and brief and had to read the source to find them (2026-11-24); the
  // skill now carries a complete example, and it must stay one.
  const skill = readFileSync(new URL("../packages/micromanager/skills/deck/SKILL.md", import.meta.url), "utf8")
  const example = /```json\n([\s\S]*?)```/.exec(skill)?.[1]
  assert.ok(example, "the skill has a json example")
  const parsed = parseSpec("deck", JSON.parse(example))
  assert.deepEqual(parsed.errors, [])
})
