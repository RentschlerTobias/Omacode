// The storyboard (B2-T3): a plan's prose and its promoted clips become beats, the beats render to a Markdown table a
// person can edit, and the table parses back to the same board. The three refusals these tests pin are the ones a later
// round depends on — a beat without acceptance, a first beat that does not start at 0, and a name that could not become a
// scene id — because each of them is a storyboard that would render a film nothing could check.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DEFAULT_BEAT_SECONDS,
  parseStoryboard,
  renderStoryboard,
  storyboardFromPlan,
  storyboardProblems,
  type Storyboard,
} from "../packages/artifact/src/storyboard.ts"

const plan = () => ({
  job: "demo",
  goal: "show what shipped",
  findings: ["the build is faster"],
  decisions: ["one idea per beat"],
  scenes: [
    {
      id: "opening",
      title: "Opening",
      duration: 2.5,
      asset: "clips/opening.mp4",
      captions: ["the release", "A | B"],
    },
    {
      id: "closing",
      title: "Closing",
      duration: 2.5,
      acceptance: ["the URL is on screen for the whole beat"],
    },
  ],
})

test("a storyboard renders to a table and parses back to the same beats", () => {
  const built = storyboardFromPlan(plan())
  assert.deepEqual(built.errors, [])
  const storyboard = built.storyboard
  assert.ok(storyboard)

  assert.equal(storyboard.duration, 5)
  assert.deepEqual(
    storyboard.beats.map((beat) => [beat.id, beat.at]),
    [
      ["opening", 0],
      ["closing", 2.5],
    ],
  )
  // The plan's prose is the beat sheet, the asset is the shot, the captions are the words, and the acceptance the plan did
  // not write is the beat's own two lines.
  assert.equal(storyboard.beats[0]?.what, "show what shipped")
  assert.equal(storyboard.beats[0]?.shot, 'the clip clips/opening.mp4, held for the beat')
  assert.equal(storyboard.beats[0]?.words, "the release / A | B")
  assert.equal(storyboard.beats[0]?.acceptance.length, 2)
  assert.equal(storyboard.beats[1]?.what, "the build is faster")
  assert.deepEqual(storyboard.beats[1]?.acceptance, ["the URL is on screen for the whole beat"])

  const text = renderStoryboard(storyboard)
  // The table is the document, and a bar inside a cell survives the round trip.
  assert.ok(text.includes("| beat | at | what | shot | words | acceptance |"))
  assert.ok(text.includes("A | B") || text.includes("A \\| B"))
  const parsed = parseStoryboard(text)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.storyboard, storyboard)
})

test("a beat without acceptance is refused, by the parser and by the renderer", () => {
  const built = storyboardFromPlan(plan())
  assert.ok(built.storyboard)
  const text = renderStoryboard(built.storyboard)
  // The acceptance column emptied, the other columns left exactly as the renderer wrote them.
  const edited = text.replace(
    /\| opening \| 0 \|.*\|$/m,
    "| opening | 0 | show what shipped | a title card: \"Opening\" | Opening |  |",
  )
  assert.notEqual(edited, text, "the edit must reach the acceptance cell")

  const parsed = parseStoryboard(edited)
  assert.equal(parsed.storyboard, undefined)
  assert.ok(
    parsed.errors.some((line) => line.includes("beats[0].acceptance") && line.includes("nothing can later be checked")),
    parsed.errors.join("; "),
  )

  const missing: Storyboard = {
    ...built.storyboard,
    beats: built.storyboard.beats.map((beat, index) => (index === 0 ? { ...beat, acceptance: [] } : beat)),
  }
  assert.throws(() => renderStoryboard(missing), /beats\[0\]\.acceptance/)
  assert.ok(storyboardProblems(missing).some((line) => line.includes("beats[0].acceptance")))
})

test("two scenes and one asset become two beats at the stated default duration", () => {
  const built = storyboardFromPlan({
    job: "demo",
    goal: "one idea, two shots",
    scenes: [{ id: "one", title: "One" }, { id: "two", asset: "clips/two.mp4" }],
  })
  assert.deepEqual(built.errors, [])
  const storyboard = built.storyboard
  assert.ok(storyboard)
  assert.equal(storyboard.duration, DEFAULT_BEAT_SECONDS * 2)
  assert.deepEqual(
    storyboard.beats.map((beat) => [beat.id, beat.at]),
    [
      ["one", 0],
      ["two", DEFAULT_BEAT_SECONDS],
    ],
  )
  // The default is stated, not silently applied, and it names the clip it belongs to.
  assert.ok(
    built.notes.some((note) => note.includes("clips/two.mp4") && note.includes(`default ${DEFAULT_BEAT_SECONDS} s`)),
    built.notes.join("; "),
  )
  assert.ok(
    built.notes.some((note) => note.includes("carries no acceptance")),
    built.notes.join("; "),
  )
  // The scene without a clip is a title card; the one with a clip shows it, and its acceptance names the clip.
  assert.match(storyboard.beats[0]?.shot ?? "", /title card/)
  assert.match(storyboard.beats[1]?.shot ?? "", /clips\/two\.mp4/)
  assert.ok(storyboard.beats[1]?.acceptance.some((line) => line.includes("clips/two.mp4")))
})

test("a first beat that does not start at 0, a repeated id and an unsafe name are refused at their row", () => {
  const build = (beatLine: string): string =>
    [
      "# demo — storyboard",
      "",
      "Duration: 5 s",
      "",
      "| beat | at | what | shot | words | acceptance |",
      "| --- | --- | --- | --- | --- | --- |",
      beatLine,
      "",
    ].join("\n")

  const late = parseStoryboard(build('| one | 1 | the goal | a title card | One | beat one is on screen |'))
  assert.equal(late.storyboard, undefined)
  assert.ok(late.errors.some((line) => line.includes("the first beat starts at 1 s")), late.errors.join("; "))

  const unsafe = parseStoryboard(build('| ../escape | 0 | the goal | a title card | One | beat one is on screen |'))
  assert.equal(unsafe.storyboard, undefined)
  assert.ok(unsafe.errors.some((line) => line.includes("not a safe scene id")), unsafe.errors.join("; "))

  const short = parseStoryboard(build("| one | 0 | the goal | a title card | One |"))
  assert.equal(short.storyboard, undefined)
  assert.ok(short.errors.some((line) => line.includes("expected 6 cells")), short.errors.join("; "))

  const twice = parseStoryboard(
    [
      "# demo — storyboard",
      "",
      "Duration: 5 s",
      "",
      "| beat | at | what | shot | words | acceptance |",
      "| --- | --- | --- | --- | --- | --- |",
      "| one | 0 | the goal | a title card | One | beat one is on screen |",
      "| one | 2 | the goal | a title card | One | beat one is on screen |",
      "",
    ].join("\n"),
  )
  assert.equal(twice.storyboard, undefined)
  assert.ok(twice.errors.some((line) => line.includes("is used twice")), twice.errors.join("; "))
})
