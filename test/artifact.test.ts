// The artifact specs (B1-T1) are the one description of a deck, a video, a site and an image set, so these tests fix
// that description: a valid fixture per kind, and a failure for each way the contract is meant to be strict. They
// import the source rather than the package entry, like the other tests here, so a missing workspace link cannot hide
// a broken contract.
//
// Every expectation is a whole error string where the message is the contract, and an address otherwise: a test that
// only checked "some error happened" would pass for a parser that refuses everything.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"

import { artifactsRootFor, specFromPlan, type HandoffInput } from "../packages/micromanager/src/artifact/handoff.ts"
import { parsePlanDoc, renderPlanDoc, type PlanDoc } from "../packages/micromanager/src/plandoc.ts"
import {
  assertAdapter,
  executablesOf,
  networkOf,
  type Adapter,
  type AdapterContext,
  type HostRunResult,
} from "../packages/artifact/src/adapter.ts"
import {
  CHECK_LEVELS,
  CONTRACT_CHECKS,
  SKIPPED_CODE,
  assertRegistry,
  checkPlan,
  checksFor,
  evaluate,
  type CheckDef,
  type CheckLevel,
  type CheckResult,
} from "../packages/artifact/src/checks.ts"
import {
  buildProvenance,
  manifestOf,
  modelProvenance,
  parseProvenance,
  provenancePath,
  readProvenance,
  sha256File,
  specHash,
  verifyManifest,
  writeProvenance,
  type AssetManifest,
  type Provenance,
} from "../packages/artifact/src/provenance.ts"
import {
  ARTIFACT_KINDS,
  SPEC_VERSIONS,
  canonicalJson,
  parseSpec,
  specVersionOf,
  type ArtifactKind,
  type DeckSpec,
  type ImagesSpec,
  type SiteSpec,
  type Spec,
  type VideoSpec,
} from "../packages/artifact/src/spec.ts"
import { qualityGate, type QualityInput, type QualityReport, type QualityVerdict } from "../packages/artifact/src/quality.ts"
import {
  createHostRunner,
  hostRunnerFor,
  resolveHostRun,
  type HostRunnerOptions,
} from "../packages/artifact/src/runner.ts"

const deck = {
  kind: "deck",
  version: 2,
  job: "job-1",
  brief: "a deck about the release",
  checks: ["deck-l0"],
  assets: [{ path: "assets/logo.png", sha256: "0".repeat(64) }],
  theme: { name: "release" },
  slides: [
    { id: "s1", title: "What shipped", body: "the release", notes: "say it slowly", hidden: false, asset: "assets/s1.png" },
    { id: "s2" },
  ],
}

const video = {
  kind: "video",
  version: 2,
  job: "job-1",
  brief: "a video about the release",
  engine: "hyperframes",
  fps: 30,
  size: { width: 1920, height: 1080 },
  audio: { src: "audio/theme.mp3", volume: 0.8 },
  output: { format: "mp4", quality: "high" },
  scenes: [
    {
      id: "sc1",
      title: "Intro",
      duration: 2.5,
      asset: "media/intro.png",
      captions: ["hello"],
      acceptance: ["the title is readable for the whole scene"],
    },
  ],
}

const site = {
  kind: "site",
  version: 1,
  job: "job-1",
  brief: "a site about the release",
  pages: [
    { path: "index.html", title: "Home", sections: ["hero", "releases"] },
    { path: "docs/a/b.html", title: "Nested" },
  ],
}

const images = {
  kind: "images",
  version: 2,
  job: "job-1",
  brief: "images for the release",
  model: { name: "SDXL base", file: "sdxl-base.safetensors" },
  slots: [{ id: "hero", prompt: "a calm gradient", size: { width: 512, height: 512 }, seed: 7, negative: "text", refs: ["refs/a.png"] }],
}

const fixtures: ReadonlyArray<readonly [ArtifactKind, unknown]> = [
  ["deck", deck],
  ["video", video],
  ["site", site],
  ["images", images],
]

// A deck that uses everything B3-T1 added: notes, reveals written out of order, a hotspot on the first slide and the
// branch it points to. `reveals` is deliberately not sorted, so the round-trip shows the spec keeps the author's order.
const branchedDeck = {
  kind: "deck",
  version: 2,
  job: "job-1",
  brief: "a deck about the release",
  checks: ["deck-l0"],
  assets: [{ path: "assets/logo.png", sha256: "0".repeat(64) }],
  slides: [
    {
      id: "s1",
      title: "What shipped",
      body: "the release",
      notes: "say it slowly",
      reveals: [2, 0],
      hotspots: [{ id: "more", label: "The details", target: "details" }],
    },
    { id: "s2", title: "What is next" },
  ],
  branches: [{ id: "details", label: "Under the hood", slides: [{ id: "d1", title: "How it works" }] }],
}

test("each kind parses its own fixture and hands back what was written", () => {
  assert.deepEqual([...ARTIFACT_KINDS], ["deck", "video", "site", "images"])
  for (const [kind, fixture] of fixtures) {
    const parsed = parseSpec(kind, fixture)
    assert.deepEqual(parsed.errors, [], `${kind}: ${parsed.errors.join("; ")}`)
    assert.deepEqual(parsed.spec, fixture, kind)
  }
})

test("a deck with reveals, branches and hotspots parses as written, unsorted reveals included", () => {
  const parsed = parseSpec("deck", branchedDeck)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.spec, branchedDeck)
  // The spec validates the reveal indices; it does not sort them. The manifest sorts, so [2, 0] is a set the player
  // reads the same as [0, 2], and the hash of this deck is the hash of what was written.
  assert.deepEqual(parsed.spec?.slides[0]?.reveals, [2, 0])
})

test("a spec missing its list fails at the list, not somewhere further in", () => {
  const without: Record<string, unknown> = { ...deck }
  delete without["slides"]
  const parsed = parseSpec("deck", without)
  assert.equal(parsed.spec, undefined)
  assert.deepEqual(parsed.errors, ["slides: required"])
})

test("each kind carries its own version, and the wrong one is refused by kind and number", () => {
  assert.deepEqual({ ...SPEC_VERSIONS }, { deck: 2, video: 2, site: 1, images: 2 })
  for (const kind of ARTIFACT_KINDS) assert.equal(specVersionOf(kind), SPEC_VERSIONS[kind])

  const stale = parseSpec("deck", { ...deck, version: 1 })
  assert.equal(stale.spec, undefined)
  assert.deepEqual(stale.errors, ["version: a deck spec is version 2, got 1"])

  const ahead = parseSpec("video", { ...video, version: 3 })
  assert.equal(ahead.spec, undefined)
  assert.deepEqual(ahead.errors, ["version: a video spec is version 2, got 3"])

  // A video from before B2-T2 is version 1, and the sentence names the version the contract now has.
  const previous = parseSpec("video", { ...video, version: 1 })
  assert.equal(previous.spec, undefined)
  assert.deepEqual(previous.errors, ["version: a video spec is version 2, got 1"])

  // An image set from before B5-T1 is version 1; the article is "an", because the refusal is read by a person.
  const imagesPrevious = parseSpec("images", { ...images, version: 1 })
  assert.equal(imagesPrevious.spec, undefined)
  assert.deepEqual(imagesPrevious.errors, ["version: an images spec is version 2, got 1"])

  // A site did not change in B3-T1, B2-T2 or B5-T1, so its version 1 still parses. A shared counter would have made
  // an unchanged contract invalid for a reason it did not have.
  assert.deepEqual(parseSpec("site", site).errors, [])
  assert.deepEqual(parseSpec("images", images).errors, [])
})

test("a branch is a unique id that is not the main line's, with a label and at least one slide", () => {
  const details = { id: "details", label: "Under the hood", slides: [{ id: "d1", title: "How it works" }] }

  const twice = parseSpec("deck", {
    ...deck,
    branches: [details, { ...details, label: "Again", slides: [{ id: "d2" }] }],
  })
  assert.equal(twice.spec, undefined)
  assert.deepEqual(twice.errors, ['branches[1].id: branch id "details" is already used at branches[0]'])

  // `main` is the player's own name for the line the deck starts on, so a branch cannot take it.
  const reserved = parseSpec("deck", { ...deck, branches: [{ ...details, id: "main" }] })
  assert.equal(reserved.spec, undefined)
  assert.deepEqual(reserved.errors, [
    `branches[0].id: "main" is the player's own id for the main line, so a branch cannot use it`,
  ])

  const empty = parseSpec("deck", { ...deck, branches: [{ ...details, slides: [] }] })
  assert.equal(empty.spec, undefined)
  assert.deepEqual(empty.errors, ["branches[0].slides: expected at least one entry"])
})

test("a hotspot names a branch of the same deck, checked after the whole deck is read", () => {
  const parsed = parseSpec("deck", {
    ...deck,
    slides: [{ id: "s1" }, { id: "s2", hotspots: [{ id: "more", label: "The details", target: "details" }] }],
  })
  assert.equal(parsed.spec, undefined)
  assert.deepEqual(parsed.errors, ['slides[1].hotspots[0].target: names no branch ("details")'])
})

test("a slide id is a scene id, so it is unique across the main line and every branch", () => {
  const branch = { id: "details", label: "Under the hood", slides: [{ id: "s1" }] }
  const across = parseSpec("deck", { ...deck, branches: [branch] })
  assert.equal(across.spec, undefined)
  assert.deepEqual(across.errors, ['branches[0].slides[0].id: slide id "s1" is already used at slides[0]'])

  // The same rule inside the main line, where the address is the only thing that differs.
  const inside = parseSpec("deck", { ...deck, slides: [{ id: "s1" }, { id: "s1" }] })
  assert.deepEqual(inside.errors, ['slides[1].id: slide id "s1" is already used at slides[0]'])
})

test("a reveal index is a non-negative integer written once, at its own address", () => {
  const withReveals = (reveals: unknown) => ({ ...deck, slides: [{ id: "s1", reveals }] })

  assert.deepEqual(parseSpec("deck", withReveals([0, 0])).errors, ["slides[0].reveals[1]: duplicate fragment index 0"])
  assert.deepEqual(parseSpec("deck", withReveals([-1])).errors, [
    "slides[0].reveals[0]: expected a non-negative integer, got -1",
  ])
  assert.deepEqual(parseSpec("deck", withReveals([1.5])).errors, [
    "slides[0].reveals[0]: expected a non-negative integer, got 1.5",
  ])
  // An empty list says nothing, and the indices may arrive in any order.
  assert.deepEqual(parseSpec("deck", withReveals([])).errors, [])
  assert.deepEqual(parseSpec("deck", withReveals([2, 0])).errors, [])
})

test("two hotspots on one slide cannot share an id, because a click is addressed by it", () => {
  const hotspot = { id: "more", label: "The details", target: "details" }
  const parsed = parseSpec("deck", {
    ...deck,
    slides: [{ id: "s1", hotspots: [hotspot, { ...hotspot, label: "More details" }] }],
    branches: [{ id: "details", label: "Under the hood", slides: [{ id: "d1" }] }],
  })
  assert.equal(parsed.spec, undefined)
  assert.deepEqual(parsed.errors, ['slides[0].hotspots[1].id: duplicate hotspot id "more" on this slide'])
})

test("the strictness survives the new nesting: a stranger is refused inside a branch slide, a branch and a hotspot", () => {
  const details = { id: "details", label: "Under the hood", slides: [{ id: "d1" }] }

  const inSlide = parseSpec("deck", { ...deck, branches: [{ ...details, slides: [{ id: "d1", extar: true }] }] })
  assert.deepEqual(inSlide.errors, ["branches[0].slides[0].extar: unknown key"])

  const inBranch = parseSpec("deck", { ...deck, branches: [{ ...details, extar: true }] })
  assert.deepEqual(inBranch.errors, ["branches[0].extar: unknown key"])

  const inHotspot = parseSpec("deck", {
    ...deck,
    slides: [{ id: "s1", hotspots: [{ id: "more", label: "More", target: "details", extar: true }] }],
    branches: [details],
  })
  assert.deepEqual(inHotspot.errors, ["slides[0].hotspots[0].extar: unknown key"])
})

test("an unknown key is refused where it was written", () => {
  const top = parseSpec("deck", { ...deck, extar: true })
  assert.equal(top.spec, undefined)
  assert.deepEqual(top.errors, ["extar: unknown key"])

  const [first] = deck.slides
  const nested = parseSpec("deck", { ...deck, slides: [{ ...first, extar: true }] })
  assert.equal(nested.spec, undefined)
  assert.deepEqual(nested.errors, ["slides[0].extar: unknown key"])

  // An adapter's allowlist is code (B1-T5); a spec has no field for a program, so an attempt to add one is refused at
  // its own address instead of being dropped on the way to the runner.
  assert.deepEqual(parseSpec("deck", { ...deck, executables: ["sh"] }).errors, ["executables: unknown key"])
})

test("a spec of the wrong kind names both kinds", () => {
  const { errors } = parseSpec("video", deck)
  assert.match(errors.join("\n"), /^kind: expected "video", got "deck"$/m)
})

test("a page path must stay inside the job directory, lexically", () => {
  const [home] = site.pages
  for (const path of ["/abs.html", "../up.html", "a/../../b.html", "a\\b.html", ""]) {
    const { errors } = parseSpec("site", { ...site, pages: [{ ...home, path }] })
    assert.equal(errors.length, 1, `${path}: ${errors.join("; ")}`)
    assert.match(errors[0]!, /^pages\[0\]\.path: /)
  }
  const nested = parseSpec("site", { ...site, pages: [{ ...home, path: "a/b.html" }] })
  assert.deepEqual(nested.errors, [])
})

test("an out-of-range number, a fractional pixel size and an empty list each fail at their own path", () => {
  assert.deepEqual(parseSpec("video", { ...video, fps: 0 }).errors, [
    "fps: expected a number greater than 0 and at most 240, got 0",
  ])
  assert.deepEqual(parseSpec("video", { ...video, size: { ...video.size, width: 1.5 } }).errors, [
    "size.width: expected a positive integer, got 1.5",
  ])
  assert.deepEqual(parseSpec("deck", { ...deck, slides: [] }).errors, ["slides: expected at least one entry"])
})

test("canonical json does not move when a key moves, but keeps array order", () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), '{"a":1,"b":{"c":2,"d":3}}')
  assert.equal(canonicalJson({ a: [3, 1] }), '{"a":[3,1]}')
  assert.notEqual(canonicalJson({ a: [3, 1] }), canonicalJson({ a: [1, 3] }))
})

// The checks registry (B1-T2) is where a check stops being a promise and becomes a verdict, so these tests fix the
// three things a caller may rely on: a registry that says who runs what, a plan that never runs a later level over a
// failed earlier one, and a coverage report that treats a skip as a gap rather than a pass.

const def = (id: string, level: CheckLevel, extra: Partial<CheckDef> = {}): CheckDef => ({
  id,
  level,
  kind: "deck",
  title: id,
  run: level === "L0" ? "spec" : level === "L3" ? "human" : "argv",
  ...extra,
})

const passed = (id: string, level: CheckLevel): CheckResult => ({ id, level, status: "passed", code: 0 })
const failed = (id: string, level: CheckLevel): CheckResult => ({
  id,
  level,
  status: "failed",
  code: 1,
  output: `${id} broke`,
})
const skipped = (id: string, level: CheckLevel, reason = "no browser here"): CheckResult => ({
  id,
  level,
  status: "skipped",
  code: SKIPPED_CODE,
  reason,
})

test("the registry refuses a duplicate id, a level that lies about who runs it, and an id that is not its kind", () => {
  const contract = def("deck.contract", "L0")
  const cases: ReadonlyArray<readonly [readonly CheckDef[], string]> = [
    [[contract, contract], "duplicate"],
    [[def("deck.contract", "L0", { run: "argv" })], 'L0 must run as "spec"'],
    [[def("deck.human", "L3", { run: "argv" })], 'L3 must run as "human"'],
    [[def("deck.contract", "L0", { kind: "video" })], 'the id says "deck" but the kind is "video"'],
    [[def("deckish.thing", "L1")], "known artifact kind"],
  ]
  for (const [defs, expected] of cases) {
    const id = defs[0]!.id
    assert.throws(
      () => assertRegistry(defs),
      (error: unknown) => error instanceof Error && error.message.includes(id) && error.message.includes(expected),
      `expected ${id} to be refused with ${expected}`,
    )
  }
})

test("the shipped registry is one valid L0 contract check per kind", () => {
  assert.deepEqual([...CHECK_LEVELS], ["L0", "L1", "L2", "L3"])
  assert.doesNotThrow(() => assertRegistry(CONTRACT_CHECKS))
  assert.deepEqual(
    CONTRACT_CHECKS.map((entry) => entry.id).sort(),
    ["deck.contract", "images.contract", "site.contract", "video.contract"],
  )
  assert.deepEqual(
    CONTRACT_CHECKS.map((entry) => entry.kind).sort(),
    [...ARTIFACT_KINDS].sort(),
  )
  for (const entry of CONTRACT_CHECKS) {
    assert.equal(entry.level, "L0", entry.id)
    assert.equal(entry.run, "spec", entry.id)
    assert.equal(entry.required, true, entry.id)
  }
})

const planRegistry: readonly CheckDef[] = [
  def("deck.human", "L3"),
  def("deck.mech", "L1"),
  def("deck.contract", "L0"),
  def("deck.visual", "L2"),
]

test("a plan reads levels in order however the registry is ordered", () => {
  const first = checkPlan(planRegistry, [])
  assert.deepEqual(first.next.map((entry) => entry.id), ["deck.contract"])
  assert.deepEqual(first.skip, [])

  const afterContract = checkPlan(planRegistry, [passed("deck.contract", "L0")])
  assert.deepEqual(afterContract.next.map((entry) => entry.id), ["deck.mech"])
  assert.deepEqual(afterContract.skip, [])

  const afterMechanical = checkPlan(planRegistry, [passed("deck.contract", "L0"), passed("deck.mech", "L1")])
  assert.deepEqual(afterMechanical.next.map((entry) => entry.id), ["deck.visual"])
  assert.equal(afterMechanical.next.some((entry) => entry.level === "L3"), false)
})

test("a failed contract skips everything after it and names what failed", () => {
  const plan = checkPlan(planRegistry, [failed("deck.contract", "L0")])
  assert.deepEqual(plan.next, [])
  assert.deepEqual(plan.skip.map((entry) => entry.id), ["deck.mech", "deck.visual", "deck.human"])
  for (const entry of plan.skip) assert.equal(entry.reason, "not run: L0 failed (deck.contract)")
})

test("one failed check does not cut its own level short, only the levels after it", () => {
  const defs: readonly CheckDef[] = [
    def("deck.contract", "L0"),
    def("deck.overflow", "L1"),
    def("deck.links", "L1"),
    def("deck.visual", "L2"),
    def("deck.human", "L3"),
  ]
  const plan = checkPlan(defs, [passed("deck.contract", "L0"), failed("deck.overflow", "L1")])
  // The sibling still runs, so the report names every problem in this level; the failed check already has a result
  // and is not run again.
  assert.deepEqual(plan.next.map((entry) => entry.id), ["deck.links"])
  assert.deepEqual(plan.skip.map((entry) => entry.id), ["deck.visual", "deck.human"])
  assert.match(plan.skip[0]!.reason, /^not run: L1 failed \(deck\.overflow\)$/)
})

test("a required check that never ran is missing; an optional one may be absent", () => {
  const required = evaluate([def("deck.contract", "L0")], [])
  assert.equal(required.ok, false)
  assert.deepEqual(required.missing, ["deck.contract"])
  assert.deepEqual(required.results, [])

  const optional = evaluate([def("deck.visual", "L2", { required: false })], [])
  assert.equal(optional.ok, true)
  assert.deepEqual(optional.missing, [])
})

test("a skip with a reason is honest, not a pass", () => {
  const coverage = evaluate([def("deck.visual", "L2")], [skipped("deck.visual", "L2", "no browser on this machine")])
  assert.equal(coverage.ok, true)
  assert.deepEqual(coverage.skipped.map((entry) => entry.id), ["deck.visual"])
  assert.deepEqual(coverage.failed, [])
  assert.equal(coverage.results[0]!.status, "skipped")
  assert.equal(coverage.results[0]!.reason, "no browser on this machine")
})

test("a contradictory result is refused, naming the check", () => {
  const defs: readonly CheckDef[] = [def("deck.overflow", "L1")]
  const cases: ReadonlyArray<readonly [string, CheckResult, string]> = [
    ["deck.overflow", { id: "deck.overflow", level: "L1", status: "skipped", code: SKIPPED_CODE }, "skipped without a reason"],
    [
      "deck.overflow",
      { id: "deck.overflow", level: "L1", status: "skipped", code: SKIPPED_CODE, reason: "   " },
      "skipped without a reason",
    ],
    ["deck.overflow", { id: "deck.overflow", level: "L1", status: "skipped", code: 0, reason: "no browser" }, "expected -1"],
    ["deck.overflow", { id: "deck.overflow", level: "L1", status: "passed", code: 1 }, "passed with exit code 1"],
    ["deck.overflow", { id: "deck.overflow", level: "L1", status: "failed", code: 0 }, "failed with exit code 0"],
    ["deck.nope", passed("deck.nope", "L1"), "unknown check"],
  ]
  for (const [id, result, expected] of cases) {
    const coverage = evaluate(defs, [result])
    assert.equal(coverage.ok, false)
    assert.ok(
      coverage.invalid.some((line) => line.includes(id) && line.includes(expected)),
      `expected ${id} to be refused with ${expected}, invalid: ${coverage.invalid.join("; ")}`,
    )
  }
})

test("evaluate sorts results by level and then by id, however they arrive", () => {
  const defs: readonly CheckDef[] = [
    def("deck.zeta", "L1"),
    def("deck.contract", "L0"),
    def("deck.alpha", "L1"),
    def("deck.visual", "L2"),
  ]
  const shuffled = [
    passed("deck.zeta", "L1"),
    passed("deck.visual", "L2"),
    passed("deck.alpha", "L1"),
    passed("deck.contract", "L0"),
  ]
  assert.deepEqual(
    evaluate(defs, shuffled).results.map((entry) => entry.id),
    ["deck.contract", "deck.alpha", "deck.zeta", "deck.visual"],
  )
})

test("checksFor hands one artifact type its own checks in level order", () => {
  assert.deepEqual(
    checksFor(CONTRACT_CHECKS, "deck").map((entry) => entry.id),
    ["deck.contract"],
  )

  const mixed: readonly CheckDef[] = [
    def("deck.human", "L3"),
    def("deck.contract", "L0"),
    def("video.contract", "L0", { kind: "video" }),
  ]
  assert.deepEqual(
    checksFor(mixed, "deck").map((entry) => entry.id),
    ["deck.contract", "deck.human"],
  )
  assert.deepEqual(checksFor(mixed, "site"), [])
})

// Provenance (B1-T3) is the record that travels with an artifact, so these tests fix the facts a later reader relies
// on: a hash of the bytes rather than a name, a licence and territory that are never defaulted, a spec hash that moves
// only when the spec does, and a manifest that notices a changed or deleted file while tolerating the runner's litter.

const provenanceTool = { name: "hyperframes", version: "0.4.2", license: "Apache-2.0", territory: "EU" } as const
const createdAt = "2026-01-02T03:04:05.000Z"

const sampleProvenance = (): Provenance =>
  buildProvenance({
    tool: provenanceTool,
    model: {
      name: "sdxl",
      version: "1.0",
      file: "/models/sdxl.safetensors",
      sha256: "a".repeat(64),
      verified: true,
      license: "CreativeML Open RAIL++-M",
      territory: "EU",
    },
    seed: 42,
    inputs: [{ path: "brief.md", sha256: "b".repeat(64) }],
    spec: { kind: "deck", version: specVersionOf("deck"), sha256: specHash(deck) },
    createdAt,
  })

test("a file hashes to the known sha256 of its bytes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-provenance-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, "hello.txt")
  writeFileSync(file, "hello\n")
  assert.equal(await sha256File(file), "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
})

test("a model records the hash of its file, and a declared hash that disagrees names both", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-provenance-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, "model.bin")
  writeFileSync(file, "real bytes standing in for a checkpoint\n")
  const real = await sha256File(file)

  const fromFile = await modelProvenance({ name: "fake", file, version: "0.1", license: "Apache-2.0", territory: "EU" })
  assert.deepEqual(fromFile.errors, [])
  assert.equal(fromFile.model?.sha256, real)
  assert.equal(fromFile.model?.verified, true)
  assert.equal(fromFile.model?.file, file)

  const declared = "0".repeat(64)
  const disagree = await modelProvenance({ name: "fake", file, sha256: declared, license: "Apache-2.0", territory: "EU" })
  assert.equal(disagree.model, undefined)
  assert.equal(disagree.errors.length, 1, disagree.errors.join("; "))
  assert.ok(
    disagree.errors[0]!.includes(declared) && disagree.errors[0]!.includes(real),
    `the error must name both hashes, got: ${disagree.errors[0]}`,
  )

  const agreeing = await modelProvenance({ name: "fake", file, sha256: real, license: "Apache-2.0", territory: "EU" })
  assert.deepEqual(agreeing.errors, [])
  assert.equal(agreeing.model?.verified, true)
  assert.equal(agreeing.model?.sha256, real)
})

test("no file and no declared hash is refused; a declared hash without a file is recorded unverified", async () => {
  const missing = await modelProvenance({ name: "remote", license: "proprietary", territory: "EU" })
  assert.equal(missing.model, undefined)
  assert.deepEqual(missing.errors, ["sha256: required when there is no file to hash"])

  const declared = "c".repeat(64)
  const remote = await modelProvenance({ name: "remote", sha256: declared, license: "proprietary", territory: "EU" })
  assert.deepEqual(remote.errors, [])
  assert.equal(remote.model?.sha256, declared)
  assert.equal(remote.model?.verified, false)
  assert.equal(remote.model?.file, undefined)
})

test("an empty licence or territory is refused by name, never defaulted", async () => {
  const declared = "d".repeat(64)
  const noLicense = await modelProvenance({ name: "m", sha256: declared, license: "", territory: "EU" })
  assert.deepEqual(noLicense.errors, ["license: expected a non-empty string"])
  const noTerritory = await modelProvenance({ name: "m", sha256: declared, license: "Apache-2.0", territory: "" })
  assert.deepEqual(noTerritory.errors, ["territory: expected a non-empty string"])
  const noVersion = await modelProvenance({ name: "m", version: "", sha256: declared, license: "Apache-2.0", territory: "EU" })
  assert.deepEqual(noVersion.errors, ["version: expected a non-empty string"])

  const unnamed = await modelProvenance({ name: "", license: "", territory: "" })
  assert.ok(unnamed.errors.some((line) => line === "name: expected a non-empty string"))
  assert.ok(unnamed.errors.some((line) => line.startsWith("model: ")))
})

test("a spec hashes the same whatever the key order, and differently when a slide title changes", () => {
  const one = { kind: "deck", version: 2, job: "job-1", brief: "b", slides: [{ id: "s1", title: "One" }] }
  const reordered = { slides: [{ title: "One", id: "s1" }], brief: "b", job: "job-1", version: 2, kind: "deck" }
  const changed = { ...one, slides: [{ id: "s1", title: "Two" }] }
  assert.equal(specHash(one), specHash(reordered))
  assert.notEqual(specHash(one), specHash(changed))
  assert.match(specHash(one), /^[0-9a-f]{64}$/)
})

test("a manifest records bytes, hash and source; a rewrite is changed, a deletion missing, an extra file ignored", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-manifest-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const job = join(dir, "job")
  mkdirSync(job)
  const first = join(job, "deck.html")
  const second = join(job, "brief.md")
  writeFileSync(first, "hello\n")
  writeFileSync(second, "a brief\n")

  const manifest = await manifestOf(job, [
    { path: "deck.html", source: "tool" },
    { path: "brief.md", source: "input" },
  ])
  assert.deepEqual(
    manifest.assets.map((entry) => [entry.path, entry.source]),
    [
      ["deck.html", "tool"],
      ["brief.md", "input"],
    ],
  )
  assert.equal(manifest.assets[0]!.bytes, Buffer.byteLength("hello\n"))
  assert.equal(manifest.assets[0]!.sha256, "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
  assert.equal(manifest.assets[1]!.bytes, Buffer.byteLength("a brief\n"))
  assert.equal(manifest.assets[1]!.sha256, await sha256File(second))
  assert.deepEqual(await verifyManifest(job, manifest), { ok: true, missing: [], changed: [], outside: [] })

  // The same byte count, different bytes: only the hash can notice this.
  writeFileSync(first, "HELLO\n")
  assert.deepEqual(await verifyManifest(job, manifest), {
    ok: false,
    missing: [],
    changed: ["deck.html"],
    outside: [],
  })

  rmSync(second)
  const after = await verifyManifest(job, manifest)
  assert.equal(after.ok, false)
  assert.deepEqual(after.changed, ["deck.html"])
  assert.deepEqual(after.missing, ["brief.md"])

  // The runner leaves temp files behind; a manifest is a lower bound, so a stranger on disk is not a failure.
  writeFileSync(join(job, "leftover.tmp"), "temp\n")
  const withExtra = await verifyManifest(job, manifest)
  assert.deepEqual(withExtra.changed, ["deck.html"])
  assert.deepEqual(withExtra.missing, ["brief.md"])

  await assert.rejects(manifestOf(job, [{ path: "../outside.txt", source: "tool" }]), /must not contain/)
})

test("a symlink inside the job that points out is outside, not a file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-manifest-link-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const job = join(dir, "job")
  mkdirSync(job)
  const outside = join(dir, "outside.txt")
  writeFileSync(outside, "not in the job\n")
  symlinkSync(outside, join(job, "link.txt"))

  const manifest: AssetManifest = {
    assets: [
      {
        path: "link.txt",
        bytes: Buffer.byteLength("not in the job\n"),
        sha256: await sha256File(outside),
        source: "tool",
      },
    ],
  }
  const verdict = await verifyManifest(job, manifest)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.outside, ["link.txt"])
  assert.deepEqual(verdict.missing, [])
  assert.deepEqual(verdict.changed, [])

  await assert.rejects(manifestOf(job, [{ path: "link.txt", source: "tool" }]), /link\.txt: resolves outside the job directory/)
})

test("a provenance is written 0600 beside a 0700 job and read back as the same record", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-provenance-write-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const job = join(dir, "job")
  const record = sampleProvenance()

  const path = await writeProvenance(job, record)
  assert.equal(path, provenancePath(job))
  assert.equal(path, join(job, "provenance.json"))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(job).mode & 0o777, 0o700)
  assert.deepEqual(await readProvenance(job), { provenance: record, errors: [] })

  assert.deepEqual(await readProvenance(join(dir, "empty-job")), { errors: ["no provenance.json yet"] })
})

test("provenance parsing refuses an unknown key at every level and a verified hash with no file", () => {
  const record = sampleProvenance()
  assert.deepEqual(parseProvenance(record), { provenance: record, errors: [] })

  assert.deepEqual(parseProvenance({ ...record, extra: true }).errors, ["extra: unknown key"])
  assert.deepEqual(parseProvenance({ ...record, tool: { ...record.tool, extra: true } }).errors, ["tool.extra: unknown key"])
  assert.deepEqual(parseProvenance({ ...record, spec: { ...record.spec, extra: true } }).errors, ["spec.extra: unknown key"])
  assert.deepEqual(parseProvenance({ ...record, inputs: [{ ...record.inputs[0]!, extra: true }] }).errors, [
    "inputs[0].extra: unknown key",
  ])

  const { file: _file, ...modelWithoutFile } = record.model!
  const contradiction = { ...record, model: { ...modelWithoutFile, verified: true } }
  const parsed = parseProvenance(contradiction)
  assert.equal(parsed.provenance, undefined)
  assert.equal(parsed.errors.length, 1, parsed.errors.join("; "))
  assert.match(parsed.errors[0]!, /^model\.verified: true needs model\.file/)
  assert.throws(() => buildProvenance(contradiction), /model\.verified: true needs model\.file/)
})

// The adapter interface (B1-T4) is the contract the four real adapters will implement and the runner (B1-T5) will be
// built from, so these tests fix the two things the runner may rely on: a complete adapter is a value with six methods,
// and its allowlist and network declaration cannot be widened — not by a spec, not by mutating the array afterwards,
// and not by a caller adding to what `executablesOf` handed them.

const fakeContext = (): AdapterContext => ({
  jobDir: "/job",
  specPath: "/job/spec.json",
  run: {
    async run(): Promise<HostRunResult> {
      return { passed: true, code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }
    },
    cancel() {},
  },
  log: () => {},
})

// The complete fake adapter the other cases are derived from. `prepared` is beside the contract, not part of it: it is
// the seam the "prepare receives the spec" test reads.
const fakeAdapter = (): Adapter & { readonly prepared: Spec[] } => {
  const prepared: Spec[] = []
  return {
    kind: "deck",
    name: "fake-deck",
    version: "1.2.3",
    executables: ["node"],
    network: false,
    prepared,
    async prepare(spec) {
      prepared.push(spec)
      return { notes: ["read the spec"] }
    },
    async render() {
      return { outputs: ["deck.html"] }
    },
    async snapshot() {
      return { shots: [{ path: "shots/s1.png", label: "slide 1" }] }
    },
    async check(_ctx, defs) {
      return defs.map((def): CheckResult => ({ id: def.id, level: def.level, status: "passed", code: 0 }))
    },
    async openEditor() {},
    cancel() {},
  }
}

const withExecutables = (executables: readonly string[]): Adapter => ({ ...fakeAdapter(), executables })

test("a complete fake adapter passes the contract, and every step is callable with a declared context", async () => {
  const adapter = fakeAdapter()
  assert.doesNotThrow(() => assertAdapter(adapter))
  assert.deepEqual(executablesOf(adapter), ["node"])
  assert.equal(networkOf(adapter), false)

  const ctx = fakeContext()
  const spec = parseSpec("deck", deck).spec!
  assert.deepEqual(await adapter.prepare(spec, ctx), { notes: ["read the spec"] })
  assert.deepEqual(await adapter.render(ctx), { outputs: ["deck.html"] })
  assert.deepEqual(await adapter.snapshot(ctx), { shots: [{ path: "shots/s1.png", label: "slide 1" }] })

  const defs = checksFor(CONTRACT_CHECKS, "deck")
  assert.deepEqual(await adapter.check(ctx, defs), [{ id: "deck.contract", level: "L0", status: "passed", code: 0 }])

  await adapter.openEditor?.(ctx)
  await adapter.cancel?.()
})

test("a shell, a path, a command line or a leading dash is refused as an executable; an empty allowlist needs the network", () => {
  assert.throws(
    () => assertAdapter(withExecutables(["sh"])),
    (error: unknown) => error instanceof Error && error.message.includes('"sh"') && error.message.includes("shell"),
    "sh must be refused by name",
  )
  // The extensions are the same shells: refusing only the bare name would leave the spellings that name them on another
  // host.
  assert.throws(() => assertAdapter(withExecutables(["bash.exe"])), /"bash\.exe".*shell/)

  for (const entry of ["/bin/node", "node --version", "-x"]) {
    assert.throws(
      () => assertAdapter(withExecutables([entry])),
      (error: unknown) => error instanceof Error && error.message.includes(JSON.stringify(entry)),
      `${entry} must be refused`,
    )
  }

  assert.throws(() => assertAdapter(withExecutables([])), /executables: expected at least one/)

  // An adapter that runs no program is a real shape since B5: the image adapter talks to ComfyUI and spawns nothing. Its
  // one capability is the socket, and `network: true` is what makes an empty allowlist honest rather than empty.
  assert.doesNotThrow(() => assertAdapter({ ...fakeAdapter(), executables: [], network: true }))
})

test("the allowlist is a frozen copy, so neither a later mutation nor a caller can widen it", () => {
  const executables = ["node"]
  const adapter: Adapter = { ...fakeAdapter(), executables }
  const list = executablesOf(adapter)
  assert.deepEqual([...list], ["node"])
  assert.equal(Object.isFrozen(list), true)

  // The adapter still holds its own array; changing it must not change the list the runner was already handed.
  executables.push("rm")
  assert.deepEqual([...list], ["node"])

  // The test file is ESM, so this runs in strict mode and the push throws instead of being ignored.
  assert.throws(() => {
    (list as string[]).push("rm")
  }, TypeError)
})

test("an adapter missing a step, or of a kind this package does not know, is refused by name", () => {
  const { check: _check, ...withoutCheck } = fakeAdapter()
  assert.throws(
    () => assertAdapter(withoutCheck as unknown as Adapter),
    (error: unknown) => error instanceof Error && error.message.includes('"fake-deck"') && error.message.includes("check"),
  )

  assert.throws(
    () => assertAdapter({ ...fakeAdapter(), kind: "gif" } as never),
    (error: unknown) => error instanceof Error && error.message.includes('"gif"') && error.message.includes("deck, video, site, images"),
  )
})

test("an adapter that invents a check id still passes here: evaluate (B1-T2) refuses that, once, in one place", () => {
  // A result for an id it was not given is refused by `evaluate`, which is where the defs and the results meet. This
  // file does not duplicate that rule: an adapter is a value with methods, not a registry, and a second copy of the
  // rule here could drift from the first.
  const adapter: Adapter = {
    ...fakeAdapter(),
    async check(_ctx, defs) {
      return [
        ...defs.map((def): CheckResult => ({ id: def.id, level: def.level, status: "passed", code: 0 })),
        { id: "deck.invented", level: "L1", status: "passed", code: 0 },
      ]
    },
  }
  assert.doesNotThrow(() => assertAdapter(adapter))
})

test("prepare receives the spec it was given, not a copy or a re-parse", async () => {
  const adapter = fakeAdapter()
  const spec = parseSpec("deck", deck).spec!
  await adapter.prepare(spec, fakeContext())
  assert.deepEqual(adapter.prepared, [deck])
  assert.equal(adapter.prepared[0], spec)
})

// The host runner (B1-T5) is the one place a program runs outside the worker sandbox, so these tests try to get out of
// it the ways a spec, an argument or a planted file would: another program, an argv string re-split by a shell, a path
// that leaves the job, an inherited secret, a network where none was declared, a child that never ends, one that ends
// but leaves a process group, and a second run while the first is alive. Each test that needs no network uses
// `network: true` on purpose: the path, argv and environment rules are the runner's own, and only the two bubblewrap
// tests depend on the host.

const jobRoot = (t: TestContext): { root: string; job: string } => {
  const root = mkdtempSync(join(tmpdir(), "mm-hostrun-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const job = join(root, "job")
  mkdirSync(job)
  return { root, job }
}

const hostOptions = (jobDir: string, extra: Partial<HostRunnerOptions> = {}): HostRunnerOptions => ({
  allow: ["node"],
  jobDir,
  // No network declaration, but no wrapper either: these cases are about argv, paths and the environment, and a host
  // without bubblewrap must still be able to test them. `path` names the real node this suite runs, so the search path
  // and the assertions cannot disagree about which program ran.
  network: true,
  path: ["/usr/bin"],
  ...extra,
})

// The pid-file handshake: the child writes its pid, the test waits for the file, then acts. A fixed sleep would either
// be slow or flaky on a machine where node starts later.
const waitFor = async (file: string, ms = 5000): Promise<void> => {
  const until = Date.now() + ms
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`${file} never appeared`)
    await new Promise((wait) => setTimeout(wait, 20))
  }
}

// The bubblewrap cases leave the search path at its default, so the system directories the runner would use on a real
// host are the ones the probe checked, instead of the pinned /usr/bin the other cases use.
const sandboxOptions = (jobDir: string, network: boolean, denyRead?: readonly string[]): HostRunnerOptions => ({
  allow: ["node"],
  jobDir,
  network,
  ...(denyRead ? { denyRead } : {}),
})

// A killed process is not gone the instant the run resolves: the group leader is reaped by the child's own process
// handling, and a grandchild is reaped by init a moment later. So the test asks for a bounded while, never once.
const gone = async (pid: number, ms = 2000): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((done) => setTimeout(done, 20))
  }
  return false
}

// Why the bubblewrap tests are skipped: the binary may be missing or unable to unshare namespaces here (the same skip
// sandbox.test.ts makes). The runner refuses rather than runs unwrapped, so a failing probe is a host limitation.
const noBwrap = (): string | undefined => {
  const probe = spawnSync(
    "bwrap",
    ["--unshare-net", "--die-with-parent", "--dev-bind", "/dev", "/dev", "--ro-bind", "/", "/", "true"],
    { stdio: "ignore" },
  )
  if (probe.error) return `no bubblewrap here: ${probe.error.message}`
  if (probe.status !== 0) return `bubblewrap cannot unshare here (exit ${String(probe.status)})`
  return undefined
}

test("the runner hands a program an argv array, so nothing re-splits an argument into words", async (t) => {
  const { job } = jobRoot(t)
  const options = hostOptions(job)
  const input = {
    exe: "node",
    args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "hello world", "a b", "semi;colon"],
  }

  const check = resolveHostRun(input, options)
  assert.equal(check.ok, true)
  if (!check.ok) return
  assert.deepEqual(check.args, input.args)
  assert.equal(check.exe, "/usr/bin/node")

  const runner = await createHostRunner(options)
  const result = await runner.run(input)
  assert.equal(result.passed, true)
  // Node takes a bare "--" as its own option terminator before it reaches the script (checked on Node 26), so it is not
  // in the output. What the test has to prove survives is the split: a spaced argument and a semicolon each arrive as
  // one argv entry, which a shell would have broken into words and a command.
  assert.deepEqual(JSON.parse(result.stdout.trim()), ["hello world", "a b", "semi;colon"])
})

test("a program that is not one bare allowlisted name is refused, and nothing runs", async (t) => {
  const { job } = jobRoot(t)
  const options = hostOptions(job)
  for (const exe of ["sh", "/bin/sh", "node --version"]) {
    const check = resolveHostRun({ exe, args: [] }, options)
    assert.equal(check.ok, false, exe)
    if (check.ok) continue
    assert.ok(check.refused.includes(exe), `${exe} must be named in: ${check.refused}`)
  }

  // End to end: the refused shell line leaves no file behind it.
  const pwned = join(job, "pwned")
  const runner = await createHostRunner(options)
  const result = await runner.run({ exe: "sh", args: ["-c", `touch ${pwned}`] })
  assert.equal(result.passed, false)
  assert.equal(result.code, -1)
  assert.ok(result.refused && result.refused.includes("sh"), result.refused)
  assert.equal(existsSync(pwned), false)
})

test("a path argument stays inside the job after symlinks, and a relative one may climb within it", async (t) => {
  const { root, job } = jobRoot(t)
  mkdirSync(join(job, "sub"))
  const outside = join(root, "outside.txt")
  writeFileSync(outside, "gone\n")
  symlinkSync(outside, join(job, "link.txt"))
  const options = hostOptions(job)

  for (const arg of ["../outside.txt", "/etc/passwd", "--out=../../x", "./link.txt"]) {
    const check = resolveHostRun({ exe: "node", args: ["-e", "0", arg] }, options)
    assert.equal(check.ok, false, arg)
    if (check.ok) continue
    assert.ok(check.refused.includes("outside the job"), check.refused)
  }

  // The rule is not only what `resolveHostRun` says: the runner really starts nothing for it, so a path outside the job
  // cannot be reached through the one interface an adapter has.
  const runner = await createHostRunner(options)
  const refused = await runner.run({ exe: "node", args: ["-e", 'require("fs").writeFileSync("ran", "1")', "/etc/passwd"] })
  assert.equal(refused.passed, false)
  assert.equal(refused.code, -1)
  assert.ok(refused.refused?.includes("outside the job"), refused.refused)
  assert.equal(existsSync(join(job, "ran")), false, "the refused run must not have started")

  const ok = resolveHostRun({ exe: "node", args: ["-e", "0", "sub/../ok.txt"] }, options)
  assert.equal(ok.ok, true)
})

test("the working directory is the job directory or a subdirectory of it, and it is what the child sees", async (t) => {
  const { root, job } = jobRoot(t)
  const elsewhere = join(root, "elsewhere")
  mkdirSync(elsewhere)
  mkdirSync(join(job, "sub"))
  const options = hostOptions(job)

  const out = resolveHostRun({ exe: "node", args: [], cwd: elsewhere }, options)
  assert.equal(out.ok, false)
  if (!out.ok) assert.ok(out.refused.includes("outside the job"), out.refused)

  const inside = resolveHostRun({ exe: "node", args: [], cwd: "sub" }, options)
  assert.equal(inside.ok, true)
  if (!inside.ok) return
  assert.equal(inside.cwd, realpathSync(join(job, "sub")))

  const runner = await createHostRunner(options)
  // End to end: a cwd outside the job is refused before anything is started, so the program cannot be made to run in
  // the runner's own directory or the user's home.
  const refused = await runner.run({ exe: "node", args: ["-e", 'require("fs").writeFileSync("ran", "1")'], cwd: elsewhere })
  assert.equal(refused.passed, false)
  assert.equal(refused.code, -1)
  assert.ok(refused.refused?.includes("outside the job"), refused.refused)
  assert.equal(existsSync(join(elsewhere, "ran")), false, "the refused run must not have started")

  const result = await runner.run({ exe: "node", args: ["-e", "console.log(process.cwd())"], cwd: "sub" })
  assert.equal(result.stdout.trim(), realpathSync(join(job, "sub")))
})

test("a program planted in the job is skipped, even when the job is on the search path", async (t) => {
  const { job } = jobRoot(t)
  const planted = join(job, "node")
  writeFileSync(planted, "#!/bin/sh\necho PWNED\n")
  chmodSync(planted, 0o755)

  const options = hostOptions(job, { path: [job, "/usr/bin"] })
  const check = resolveHostRun({ exe: "node", args: ["-e", "0"] }, options)
  assert.equal(check.ok, true)
  if (check.ok) assert.equal(check.exe, "/usr/bin/node")

  const runner = await createHostRunner(options)
  const result = await runner.run({ exe: "node", args: ["-e", 'console.log("real")'] })
  assert.equal(result.stdout.trim(), "real")
})

test("a symlink from a writable search directory into the job is skipped too", async (t) => {
  const { root, job } = jobRoot(t)
  const planted = join(job, "node")
  writeFileSync(planted, "#!/bin/sh\necho PWNED\n")
  chmodSync(planted, 0o755)
  // The user-writable directory a real PATH holds (~/.local/bin): outside the job, and allowed to contain a symlink the
  // job itself cannot distinguish from an installed program.
  const bin = join(root, "bin")
  mkdirSync(bin)
  symlinkSync(planted, join(bin, "node"))

  const options = hostOptions(job, { path: [bin, "/usr/bin"] })
  const check = resolveHostRun({ exe: "node", args: ["-e", "0"] }, options)
  assert.equal(check.ok, true)
  if (check.ok) assert.equal(realpathSync(check.exe), realpathSync("/usr/bin/node"))
})

test("the environment carries no inherited secret, and a renderer's home and temp are in the job", async (t) => {
  const { job } = jobRoot(t)
  process.env.MY_SECRET = "leak"
  t.after(() => {
    delete process.env.MY_SECRET
  })

  const options = hostOptions(job, { path: ["/usr/bin"] })
  const check = resolveHostRun({ exe: "node", args: [] }, options)
  assert.equal(check.ok, true)
  if (!check.ok) return
  assert.equal(check.env.MY_SECRET, undefined)
  assert.equal(check.env.HOME, join(realpathSync(job), ".home"))
  assert.equal(check.env.TMPDIR, join(realpathSync(job), ".tmp"))
  assert.equal(check.env.PATH, "/usr/bin")

  const runner = await createHostRunner(options)
  const result = await runner.run({ exe: "node", args: ["-e", "console.log(JSON.stringify(process.env))"] })
  assert.equal(result.stdout.includes("leak"), false)
  const seen = JSON.parse(result.stdout) as Record<string, string>
  assert.equal(seen.HOME, join(realpathSync(job), ".home"))
  assert.equal(seen.PATH, "/usr/bin")

  // A name the adapter asks for is not a way to hand a secret through: the runner refuses it and says which name.
  const granted = resolveHostRun({ exe: "node", args: [] }, hostOptions(job, { env: ["MY_SECRET"] }))
  assert.equal(granted.ok, false)
  if (!granted.ok) assert.ok(granted.refused.includes("MY_SECRET"), granted.refused)
  // Nor can a name that is not an environment name arrive and come out as a different variable.
  const folded = resolveHostRun({ exe: "node", args: [] }, hostOptions(job, { env: ["my-secret"] }))
  assert.equal(folded.ok, false)

  // End to end: an adapter asking for a secret-looking name is refused before the program starts, so the refusal is a
  // property of the runner rather than of a rule a caller could skip.
  const refusing = await createHostRunner(hostOptions(job, { env: ["MY_SECRET"] }))
  const refused = await refusing.run({ exe: "node", args: ["-e", 'require("fs").writeFileSync("leaked", "1")'] })
  assert.equal(refused.passed, false)
  assert.equal(refused.code, -1)
  assert.ok(refused.refused?.includes("MY_SECRET"), refused.refused)
  assert.equal(existsSync(join(job, "leaked")), false, "the refused run must not have started")
})

test("without a network declaration the child reaches nothing; with one it reaches the test server", async (t) => {
  const reason = noBwrap()
  if (reason) return t.skip(reason)
  const { job } = jobRoot(t)

  const server = createServer((socket) => socket.end())
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  t.after(() => server.close())
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const script = [
    `const socket = require("net").connect(${port}, "127.0.0.1")`,
    'socket.on("connect", () => { console.log("CONNECTED"); process.exit(0) })',
    'socket.on("error", () => { console.log("FAILED"); process.exit(0) })',
    'setTimeout(() => { console.log("FAILED"); process.exit(0) }, 1500)',
  ].join(";")

  const open = await (await createHostRunner(sandboxOptions(job, true))).run({
    exe: "node",
    args: ["-e", script],
    network: true,
  })
  assert.equal(open.stdout.trim(), "CONNECTED")

  const closed = await (await createHostRunner(sandboxOptions(job, false))).run({
    exe: "node",
    args: ["-e", script],
  })
  assert.equal(closed.stdout.trim(), "FAILED")
  assert.equal(closed.refused, undefined, "the run happened; the refusal is only for a policy answer")
})

test("the network is a permission: only a run that asks for it gets it, and never one the adapter did not declare", async (t) => {
  const reason = noBwrap()
  if (reason) return t.skip(reason)
  const { job } = jobRoot(t)

  // The declaration alone does not unwrap anything: a run that says nothing is wrapped, which is what keeps a check that
  // forgot to ask from silently reaching the network.
  const silent = resolveHostRun({ exe: "node", args: ["-e", "0"] }, sandboxOptions(job, true))
  assert.equal(silent.ok, true)
  if (silent.ok) assert.ok(silent.wrapper.length > 0, "a run that does not ask is still wrapped")

  // Asking is what unwraps it, and only where the adapter said it may.
  const asked = resolveHostRun({ exe: "node", args: ["-e", "0"], network: true }, sandboxOptions(job, true))
  assert.equal(asked.ok, true)
  if (asked.ok) assert.equal(asked.wrapper.length, 0)

  const widened = resolveHostRun({ exe: "node", args: ["-e", "0"], network: true }, sandboxOptions(job, false))
  assert.equal(widened.ok, false)
  if (!widened.ok) assert.match(widened.refused, /did not declare the network/)

  // And the difference is real, not only in the argv the resolver builds: the same server is reachable for the run that
  // asked and unreachable for the one that did not.
  const server = createServer((socket) => socket.end())
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  t.after(() => server.close())
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const script = [
    `const socket = require("net").connect(${port}, "127.0.0.1")`,
    'socket.on("connect", () => { console.log("CONNECTED"); process.exit(0) })',
    'socket.on("error", () => { console.log("FAILED"); process.exit(0) })',
    'setTimeout(() => { console.log("FAILED"); process.exit(0) }, 1500)',
  ].join(";")
  const open = await (await createHostRunner(sandboxOptions(job, true))).run({
    exe: "node",
    args: ["-e", script],
    network: true,
  })
  assert.equal(open.stdout.trim(), "CONNECTED")
  const closed = await (await createHostRunner(sandboxOptions(job, true))).run({ exe: "node", args: ["-e", script] })
  assert.equal(closed.stdout.trim(), "FAILED")
})

test("a run may set a declared environment name itself, and may not smuggle one in", async (t) => {
  const { job } = jobRoot(t)
  const options = hostOptions(job, { env: ["DECK_SWITCH"] })

  // The declared name carries the value the call chose, not the host's.
  process.env.DECK_SWITCH = "host"
  t.after(() => {
    delete process.env.DECK_SWITCH
  })
  const runner = await createHostRunner(options)
  const told = await runner.run({
    exe: "node",
    args: ["-e", "console.log(process.env.DECK_SWITCH ?? 'unset')"],
    env: { DECK_SWITCH: "0" },
  })
  assert.equal(told.passed, true)
  assert.equal(told.stdout.trim(), "0")

  // A name the adapter never declared is refused before anything starts, and the sentence is the reason.
  const smuggled = await runner.run({
    exe: "node",
    args: ["-e", "0"],
    env: { UNDECLARED_SWITCH: "1" },
  })
  assert.equal(smuggled.passed, false)
  assert.match(smuggled.refused ?? "", /"UNDECLARED_SWITCH" is set by this run but not declared by its adapter/)
})

test("/dev/null stays writable in the sandbox, because a spawned child opens it", async (t) => {
  const reason = noBwrap()
  if (reason) return t.skip(reason)
  const { job } = jobRoot(t)
  // The mount order used to leave /dev read-only, so `spawn` with `stdio: "ignore"` failed with EACCES and a check
  // died for a reason that had nothing to do with the deck. This is that regression, written as the smallest program
  // that shows it.
  const runner = await createHostRunner(sandboxOptions(job, false))
  const result = await runner.run({
    exe: "node",
    args: ["-e", 'require("fs").closeSync(require("fs").openSync("/dev/null", "w")); console.log("devnull ok")'],
  })
  assert.equal(result.passed, true, result.stderr || result.refused)
  assert.equal(result.stdout.trim(), "devnull ok")
})

test("a denied directory is hidden without the network declaration, and the consequence with it is that it is not", async (t) => {
  const reason = noBwrap()
  if (reason) return t.skip(reason)
  const { job } = jobRoot(t)
  const store = mkdtempSync(join(tmpdir(), "mm-hostrun-secret-"))
  t.after(() => rmSync(store, { recursive: true, force: true }))
  writeFileSync(join(store, "key.txt"), "hunter2\n")

  const script = `try { console.log("READ " + require("fs").readFileSync(${JSON.stringify(join(store, "key.txt"))}, "utf8").trim()) } catch { console.log("FAILED") }`

  const hidden = await (await createHostRunner(sandboxOptions(job, false, [store]))).run({
    exe: "node",
    args: ["-e", script],
  })
  assert.match(hidden.stdout, /FAILED/)
  assert.equal(hidden.stdout.includes("hunter2"), false)

  // The documented consequence: a run that asks for the network is not wrapped, so `denyRead` does not apply to it.
  const shown = await (await createHostRunner(sandboxOptions(job, true, [store]))).run({
    exe: "node",
    args: ["-e", script],
    network: true,
  })
  assert.match(shown.stdout, /READ hunter2/)
})

test("a run that overstays is killed with its process group and reported as timed out", async (t) => {
  const { job } = jobRoot(t)
  const runner = await createHostRunner(hostOptions(job))
  // Run unwrapped on purpose: this test is about the timeout and the process group, and bubblewrap's own start-up makes
  // a freshly spawned interpreter's first seconds unpredictable under load. The wrapped kill is covered by the cancel
  // test next door.
  const fast = await createHostRunner(hostOptions(job, { network: true }))
  const result = await fast.run({
    exe: "node",
    args: ["-e", "console.log(process.pid); setTimeout(() => {}, 10000)"],
    timeoutMs: 500,
    network: true,
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.passed, false)
  const pid = Number(result.stdout.trim())
  assert.ok(pid > 0, `the child printed its pid, got ${JSON.stringify(result.stdout)}`)
  assert.equal(await gone(pid), true, `the child ${pid} is still alive after the timeout`)
})

test("a stream longer than the cap keeps its end, because the error is there", async (t) => {
  const { job } = jobRoot(t)
  const runner = await createHostRunner(hostOptions(job))
  const result = await runner.run({
    exe: "node",
    args: ["-e", 'process.stdout.write("start" + "x".repeat(1024 * 1024) + "end")'],
  })

  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length <= 65_536, `kept ${result.stdout.length} bytes`)
  assert.equal(result.stdout.endsWith("end"), true)
  assert.equal(result.stdout.includes("start"), false)
  assert.equal(result.passed, true)
})

test("cancel kills the process group, and the run resolves as cancelled rather than failed", async (t) => {
  const { job } = jobRoot(t)
  const pidFile = join(job, "pid")
  const runner = await createHostRunner(hostOptions(job))
  const pending = runner.run({
    exe: "node",
    args: ["-e", 'require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 10000)'],
  })

  await waitFor(pidFile)
  const pid = Number(readFileSync(pidFile, "utf8"))
  runner.cancel()
  const result = await pending

  assert.equal(result.cancelled, true)
  assert.equal(result.passed, false)
  assert.equal(result.code, -1)
  assert.equal(await gone(pid), true, `the child ${pid} is still alive after the cancel`)
})

test("one run at a time: the second is refused before it spawns anything", async (t) => {
  const { job } = jobRoot(t)
  const pidFile = join(job, "pid")
  const runner = await createHostRunner(hostOptions(job))
  const first = runner.run({
    exe: "node",
    args: ["-e", 'require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 10000)'],
  })

  await waitFor(pidFile)
  const second = await runner.run({
    exe: "node",
    args: ["-e", 'require("fs").writeFileSync("second", "spawned")'],
  })
  assert.equal(second.refused, "another run is active")
  assert.equal(second.passed, false)
  assert.equal(second.code, -1)
  assert.equal(existsSync(join(job, "second")), false, "the refused run must not have started")

  runner.cancel()
  const result = await first
  assert.equal(result.cancelled, true)
})

test("hostRunnerFor takes the allowlist and the network from the adapter, and only from it", async (t) => {
  const { job } = jobRoot(t)
  // network: true so this test is about the allowlist, not about whether this host has bubblewrap.
  const declared: Adapter = { ...fakeAdapter(), executables: ["node"], network: true }
  const runner = await hostRunnerFor(declared, { jobDir: job })

  const ran = await runner.run({ exe: "node", args: ["-e", 'console.log("declared")'] })
  assert.equal(ran.passed, true)
  assert.equal(ran.stdout.trim(), "declared")

  const git = await runner.run({ exe: "git", args: ["--version"] })
  assert.equal(git.passed, false)
  assert.ok(git.refused && git.refused.includes("git"), git.refused)

  // A shell is refused before a runner exists: `executablesOf` is the only path from an adapter to the allowlist.
  await assert.rejects(hostRunnerFor(withExecutables(["sh"]), { jobDir: job }), /shell/)
})

test("the runner source has no second execution path: no command string, no shell, no synchronous spawn", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "packages", "artifact", "src", "runner.ts"), "utf8")
  for (const forbidden of ["sh -c", "execSync", "spawnSync"]) {
    assert.equal(source.includes(forbidden), false, `runner.ts must not contain ${forbidden}`)
  }
})

// The plan → artifact handoff (B1-T6) is the only bridge between a plan job and the adapter that renders its output, so
// these tests lay out what a plan really leaves: the files under <artifactsRoot>/<task>/<path> that promote.ts wrote,
// and a plan.md rendered by the plugin's own renderer rather than hand-written prose. Each test that builds a spec also
// parses it, so a mapping bug cannot hide behind the handoff's own validation happening to pass.

const handoffProject = (t: TestContext): { project: string; root: string } => {
  const project = mkdtempSync(join(tmpdir(), "mm-handoff-"))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  // The root the spec's paths are relative to, asked for the way a caller asks: never spelled out in the test.
  return { project, root: artifactsRootFor(project, "job-1") }
}

// One promoted file, written where promote.ts would have put it, and the plan.md entry that describes it.
const promoted = async (root: string, task: string, path: string, content: string): Promise<PlanDoc["artifacts"][number]> => {
  const dest = join(root, task, ...path.split("/"))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content)
  return { task, path, bytes: Buffer.byteLength(content), sha256: await sha256File(dest) }
}

const planDoc = (artifacts: PlanDoc["artifacts"], readerOnly?: string): PlanDoc => ({
  goal: "a deck about the release",
  findings: [],
  decisions: [],
  openQuestions: [],
  tasks: [{ id: "t1", title: "Draft it", role: "worker", files: [], acceptance: [] }],
  artifacts,
  risks: [],
  ...(readerOnly !== undefined ? { readerOnly } : {}),
})

const handoffOf = (root: string, planMd: string, kind: ArtifactKind, checks?: readonly string[]): HandoffInput => ({
  planMd,
  artifactsRoot: root,
  kind,
  job: "job-1",
  brief: `a ${kind} for the release`,
  ...(checks ? { checks } : {}),
})

test("a deck plan becomes one slide per promoted page, titled by its heading or, without one, by its name", async (t) => {
  const { root } = handoffProject(t)
  const headlined = await promoted(root, "t1", "deck.html", "<!doctype html><h1>What shipped</h1><p>the release</p>\n")
  const plain = await promoted(root, "t1", "notes.html", "<p>no heading in this one</p>\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([headlined, plain]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "deck", ["deck.l0"]))
  assert.deepEqual(handoff.errors, [])
  assert.deepEqual(handoff.warnings, [])
  const spec = handoff.spec
  assert.ok(spec && spec.kind === "deck")
  if (!spec || spec.kind !== "deck") return

  assert.deepEqual(
    spec.slides.map((slide) => [slide.title, slide.asset]),
    [
      ["What shipped", "t1/deck.html"],
      ["notes", "t1/notes.html"],
    ],
  )
  assert.deepEqual(
    handoff.used.map((entry) => [entry.task, entry.path, entry.sha256]),
    [
      ["t1", "t1/deck.html", headlined.sha256],
      ["t1", "t1/notes.html", plain.sha256],
    ],
  )
  assert.deepEqual(spec.checks, ["deck.l0"])
  assert.equal(spec.job, "job-1")
  // A deck spec is version 2 since B3-T1 gave it reveals, branches and hotspots; the handoff asks the contract rather
  // than writing a number of its own.
  assert.equal(spec.version, 2)
  assert.deepEqual(spec.assets?.map((asset) => asset.path), ["t1/deck.html", "t1/notes.html"])
  assert.deepEqual(parseSpec("deck", spec).errors, [])
})

test("a hash that is not the file's is refused, naming the task and both hashes", async (t) => {
  const { root } = handoffProject(t)
  const real = await promoted(root, "t1", "deck.html", "<h1>What shipped</h1>\n")
  const declared = "0".repeat(64)
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([{ ...real, sha256: declared }]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "deck"))
  assert.equal(handoff.spec, undefined)
  assert.equal(handoff.errors.length, 1, handoff.errors.join("; "))
  const [error] = handoff.errors
  assert.ok(error!.includes("t1/deck.html"), error)
  assert.ok(error!.includes(declared) && error!.includes(real.sha256), error)
})

test("a byte count that is not the file's is refused too, because the two claims must agree", async (t) => {
  const { root } = handoffProject(t)
  const real = await promoted(root, "t1", "deck.html", "<h1>What shipped</h1>\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([{ ...real, bytes: real.bytes + 1 }]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "deck"))
  assert.equal(handoff.spec, undefined)
  assert.equal(handoff.errors.length, 1, handoff.errors.join("; "))
  const [error] = handoff.errors
  assert.ok(error!.includes("t1/deck.html"), error)
  assert.match(error!, /records \d+ B, but the file is \d+ B/)
})

test("a file this kind cannot use is named in a warning, and the rest of the plan still builds", async (t) => {
  const { root } = handoffProject(t)
  const page = await promoted(root, "t1", "deck.html", "<h1>What shipped</h1>\n")
  const clip = await promoted(root, "t1", "clip.mp4", "not really a video\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([page, clip]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "deck"))
  assert.deepEqual(handoff.errors, [])
  assert.deepEqual(handoff.warnings, ["t1/clip.mp4 is not used by a deck spec"])
  const spec = handoff.spec
  assert.ok(spec && spec.kind === "deck")
  if (!spec || spec.kind !== "deck") return
  assert.deepEqual(spec.slides.map((slide) => slide.asset), ["t1/deck.html"])
  assert.deepEqual(handoff.used.map((entry) => entry.path), ["t1/deck.html"])
  assert.deepEqual(parseSpec("deck", spec).errors, [])
})

test("a deck plan that promotes only a video is an error, not an empty deck", async (t) => {
  const { root } = handoffProject(t)
  const clip = await promoted(root, "t1", "clip.mp4", "not really a video\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([clip]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "deck"))
  assert.equal(handoff.spec, undefined)
  assert.deepEqual(handoff.errors, ["the plan promotes no file a deck spec can use"])
  assert.deepEqual(handoff.used, [])
})

test("a reader-only plan says it has nothing to hand over", async (t) => {
  const { root } = handoffProject(t)
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([], "the release notes already say it"))

  const handoff = await specFromPlan(handoffOf(root, planMd, "deck"))
  assert.equal(handoff.spec, undefined)
  assert.deepEqual(handoff.errors, ["the plan is reader-only, so there is nothing to hand over"])
})

test("a plan.md this file cannot read is refused with the parser's own reason", async (t) => {
  const { root } = handoffProject(t)
  const broken = "# job-1 — plan\n\n## Goal\n\nthe release\n\n## Risks\n\n(none)\n"

  const handoff = await specFromPlan(handoffOf(root, broken, "deck"))
  assert.equal(handoff.spec, undefined)
  assert.equal(handoff.errors.length, 1, handoff.errors.join("; "))
  assert.match(handoff.errors[0]!, /^plan\.md: /)
  assert.ok(handoff.errors[0]!.includes("## Recommended tasks"), handoff.errors[0])
})

test("a video plan gives each promoted clip a scene, with the duration said to be the default", async (t) => {
  const { root } = handoffProject(t)
  const clip = await promoted(root, "t1", "clip.mp4", "pretend this is a video\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([clip]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "video"))
  assert.deepEqual(handoff.errors, [])
  const spec = handoff.spec
  assert.ok(spec && spec.kind === "video")
  if (!spec || spec.kind !== "video") return
  assert.deepEqual(spec.scenes.map((scene) => [scene.duration, scene.asset]), [[5, "t1/clip.mp4"]])
  assert.ok(
    handoff.warnings.some((line) => line.includes("t1/clip.mp4") && line.includes("default 5 s")),
    handoff.warnings.join("; "),
  )
  assert.deepEqual(handoff.used, [{ task: "t1", path: "t1/clip.mp4", sha256: clip.sha256 }])
  assert.deepEqual(parseSpec("video", spec).errors, [])
})

test("a site plan keeps the path below the task directory, and the page validates", async (t) => {
  const { root } = handoffProject(t)
  const page = await promoted(root, "t1", "sub/page.html", "<h1>Nested</h1>\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([page]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "site"))
  assert.deepEqual(handoff.errors, [])
  const spec = handoff.spec
  assert.ok(spec && spec.kind === "site")
  if (!spec || spec.kind !== "site") return
  assert.deepEqual(spec.pages, [{ path: "sub/page.html", title: "Nested" }])
  // `used` names the page as the spec does, while the asset list names the file where it is.
  assert.deepEqual(handoff.used, [{ task: "t1", path: "sub/page.html", sha256: page.sha256 }])
  assert.deepEqual(spec.assets, [{ path: "t1/sub/page.html", sha256: page.sha256 }])
  assert.deepEqual(parseSpec("site", spec).errors, [])
})

test("two tasks promoting the same page path are refused, because one page would overwrite the other", async (t) => {
  const { root } = handoffProject(t)
  const one = await promoted(root, "t1", "index.html", "<h1>First</h1>\n")
  const two = await promoted(root, "t2", "index.html", "<h1>Second</h1>\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([one, two]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "site"))
  assert.equal(handoff.spec, undefined)
  assert.deepEqual(handoff.errors, ["page index.html is promoted by both t1 and t2"])
})

test("an image plan turns a file name into a prompt, and says both the prompt and the size are defaults", async (t) => {
  const { root } = handoffProject(t)
  const image = await promoted(root, "t1", "hero.png", "png bytes standing in\n")
  const planMd = renderPlanDoc({ id: "job-1" }, planDoc([image]))

  const handoff = await specFromPlan(handoffOf(root, planMd, "images"))
  assert.deepEqual(handoff.errors, [])
  const spec = handoff.spec
  assert.ok(spec && spec.kind === "images")
  if (!spec || spec.kind !== "images") return
  assert.deepEqual(spec.slots.map((slot) => [slot.prompt, slot.size]), [["hero", { width: 1024, height: 1024 }]])
  assert.ok(handoff.warnings.some((line) => line.includes("t1/hero.png") && line.includes("the file's name")), handoff.warnings.join("; "))
  assert.ok(handoff.warnings.some((line) => line.includes("default 1024×1024")), handoff.warnings.join("; "))
  assert.deepEqual(handoff.used, [{ task: "t1", path: "t1/hero.png", sha256: image.sha256 }])
  assert.deepEqual(parseSpec("images", spec).errors, [])
})

// The quality gate (B1-T7) is the one place that answers "would you hand this to someone?", so these tests fix what
// each artifact type has to be before it ships: a deck readable without narration and with a visual check behind it, a
// video whose scenes have something in them, a site whose pages each have a title and a file of their own, an image set
// with one file per slot. They also fix the level rule the checks registry left here: a skip below L3 blocks, a skip at
// L3 warns. Nothing here renders anything, which is the point — the verdict is a function of a spec and results.

const verdictOf = (report: QualityReport, id: string): QualityVerdict => {
  const found = report.verdicts.find((verdict) => verdict.id === id)
  assert.ok(found, `no verdict "${id}" in ${report.verdicts.map((verdict) => verdict.id).join(", ")}`)
  return found
}

const deckSpec = (slides: DeckSpec["slides"]): DeckSpec => ({
  kind: "deck",
  version: SPEC_VERSIONS.deck,
  job: "job-1",
  brief: "a deck about the release",
  slides,
})

const videoSpec = (scenes: VideoSpec["scenes"]): VideoSpec => ({
  kind: "video",
  version: SPEC_VERSIONS.video,
  job: "job-1",
  brief: "a video about the release",
  engine: "hyperframes",
  fps: 30,
  size: { width: 1920, height: 1080 },
  scenes,
})

const siteSpec = (pages: SiteSpec["pages"]): SiteSpec => ({
  kind: "site",
  version: SPEC_VERSIONS.site,
  job: "job-1",
  brief: "a site about the release",
  pages,
})

const imagesSpec = (slots: ImagesSpec["slots"]): ImagesSpec => ({
  kind: "images",
  version: SPEC_VERSIONS.images,
  job: "job-1",
  brief: "images for the release",
  slots,
})

// A deck every rule can agree with, and the one visual check it needs: the tests below change one thing at a time.
const greenDeck = (): DeckSpec =>
  deckSpec([
    { id: "s1", title: "What shipped", body: "the release\nand one line more" },
    { id: "s2", title: "What is next", body: "the roadmap" },
  ])

const deckVisualDefs: readonly CheckDef[] = [def("deck.visual", "L2")]
const deckVisualPassed: readonly CheckResult[] = [passed("deck.visual", "L2")]

test("a titled, short, visually checked deck ships, and its verdicts come out in the fixed order", () => {
  const report = qualityGate({ spec: greenDeck(), defs: deckVisualDefs, results: deckVisualPassed })

  assert.equal(report.ship, true)
  assert.deepEqual(
    report.verdicts.map((verdict) => verdict.id),
    ["checks.contract", "checks.skipped", "deck.readable", "deck.one-idea", "deck.visual"],
  )
  assert.deepEqual(report.warnings, [])
  for (const verdict of report.verdicts) assert.equal(verdict.ok, true, `${verdict.id}: ${verdict.why}`)
})

test("a skip the registry predicted is a warning; a skip nobody predicted blocks shipping", () => {
  // A vision check with no local model is the case this exists for: the registry says in advance that it may be absent,
  // so its absence is a warning a reader can act on, not a hole the gate mistakes for a pass.
  const withVision = (skippable: boolean): readonly CheckDef[] => [def("deck.visual", "L2"), def("deck.vlm", "L2", { skippable })]
  const results: readonly CheckResult[] = [passed("deck.visual", "L2"), skipped("deck.vlm", "L2", "no local vision model")]

  const predicted = qualityGate({ spec: greenDeck(), defs: withVision(true), results })
  assert.equal(predicted.ship, true, predicted.verdicts.filter((v) => !v.ok).map((v) => `${v.id}: ${v.why}`).join("; "))
  assert.deepEqual(predicted.warnings, ["deck.vlm was skipped: no local vision model"])

  const unexpected = qualityGate({ spec: greenDeck(), defs: withVision(false), results })
  assert.equal(unexpected.ship, false, "an unpredicted skip is still a hole")
  const skippedVerdict = unexpected.verdicts.find((verdict) => verdict.id === "checks.skipped")
  assert.equal(skippedVerdict?.ok, false)
  assert.match(skippedVerdict?.why ?? "", /deck\.vlm was skipped: no local vision model/)
})

test("a slide with no title cannot be read without narration, and the slide is named", () => {
  const report = qualityGate({
    spec: deckSpec([{ id: "s1", title: "What shipped" }, { id: "s2", body: "the content that had a title" }]),
    defs: deckVisualDefs,
    results: deckVisualPassed,
  })

  const readable = verdictOf(report, "deck.readable")
  assert.equal(report.ship, false)
  assert.equal(readable.ok, false)
  assert.ok(readable.why.includes("s2"), readable.why)
  assert.equal(readable.why.includes("s1"), false, readable.why)
})

test("more than six body lines is more than one idea, and blank lines are not ideas", () => {
  const eight = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n")
  const crowded = qualityGate({
    spec: deckSpec([{ id: "s1", title: "One slide", body: eight }]),
    defs: deckVisualDefs,
    results: deckVisualPassed,
  })
  const oneIdea = verdictOf(crowded, "deck.one-idea")
  assert.equal(oneIdea.ok, false)
  assert.ok(oneIdea.why.includes("s1") && oneIdea.why.includes("8 lines"), oneIdea.why)
  assert.equal(crowded.ship, false)

  // The same six lines with empty lines between them: padding is layout, so it does not count as content.
  const spaced = ["one", "", "two", "", "three", "", "four", "", "five", "", "six"].join("\n")
  const roomy = qualityGate({
    spec: deckSpec([{ id: "s1", title: "One slide", body: spaced }]),
    defs: deckVisualDefs,
    results: deckVisualPassed,
  })
  assert.equal(verdictOf(roomy, "deck.one-idea").ok, true)
})

test("a deck with no L2 check at all is refused: a deck needs a visual check", () => {
  const report = qualityGate({ spec: greenDeck(), defs: [], results: [] })

  const visual = verdictOf(report, "deck.visual")
  assert.equal(visual.ok, false)
  assert.match(visual.why, /a deck needs a visual check/)
  assert.equal(report.ship, false)
})

test("an L2 skip leaves the deck unchecked, and both the check and the reason are in the verdict", () => {
  const report = qualityGate({
    spec: greenDeck(),
    defs: deckVisualDefs,
    results: [skipped("deck.visual", "L2", "no browser on this machine")],
  })

  const skip = verdictOf(report, "checks.skipped")
  assert.equal(report.ship, false)
  assert.equal(skip.ok, false)
  assert.ok(skip.why.includes("deck.visual") && skip.why.includes("no browser on this machine"), skip.why)
  assert.equal(verdictOf(report, "deck.visual").ok, false)
})

test("a failed check, an invalid result and a required check that never ran each fail by name", () => {
  const defs: readonly CheckDef[] = [def("deck.links", "L1"), def("deck.visual", "L2")]

  const failedReport = qualityGate({
    spec: greenDeck(),
    defs,
    results: [failed("deck.links", "L1"), passed("deck.visual", "L2")],
  })
  const failedVerdict = verdictOf(failedReport, "checks.contract")
  assert.equal(failedReport.ship, false)
  assert.equal(failedVerdict.ok, false)
  assert.ok(failedVerdict.why.includes("deck.links"), failedVerdict.why)

  // A result that contradicts itself is refused by evaluate, and the contract verdict repeats its reason.
  const invalidReport = qualityGate({
    spec: greenDeck(),
    defs,
    results: [{ id: "deck.links", level: "L1", status: "passed", code: 1 }, passed("deck.visual", "L2")],
  })
  const invalidVerdict = verdictOf(invalidReport, "checks.contract")
  assert.equal(invalidVerdict.ok, false)
  assert.ok(invalidVerdict.why.includes("deck.links") && invalidVerdict.why.includes("exit code 1"), invalidVerdict.why)

  const missingReport = qualityGate({
    spec: greenDeck(),
    defs: [def("deck.links", "L1")],
    results: [],
  })
  const missingVerdict = verdictOf(missingReport, "checks.contract")
  assert.equal(missingReport.ship, false)
  assert.equal(missingVerdict.ok, false)
  assert.match(missingVerdict.why, /missing: deck\.links/)
})

test("a human check nobody ran is a warning, not a reason to hold the artifact", () => {
  const report = qualityGate({
    spec: greenDeck(),
    defs: [...deckVisualDefs, def("deck.human", "L3")],
    results: [...deckVisualPassed, skipped("deck.human", "L3", "nobody has looked yet")],
  })

  assert.equal(report.ship, true)
  assert.equal(verdictOf(report, "checks.skipped").ok, true)
  assert.ok(
    report.warnings.some((line) => line.includes("deck.human") && line.includes("nobody has looked yet")),
    report.warnings.join("; "),
  )
})

test("a video scene with no asset is a caption over nothing, and the scene is named", () => {
  const report = qualityGate({
    spec: videoSpec([
      { id: "sc1", duration: 2.5, asset: "media/intro.png" },
      { id: "sc2", duration: 2.5 },
    ]),
    defs: [def("video.visual", "L2", { kind: "video" })],
    results: [passed("video.visual", "L2")],
  })

  const scenes = verdictOf(report, "video.scenes")
  assert.equal(report.ship, false)
  assert.equal(scenes.ok, false)
  assert.ok(scenes.why.includes("sc2"), scenes.why)
  assert.equal(scenes.why.includes("sc1"), false, scenes.why)
})

test("two site pages writing one file are one file, and the path is named", () => {
  const report = qualityGate({
    spec: siteSpec([
      { path: "a.html", title: "First" },
      { path: "a.html", title: "Second" },
    ]),
    defs: [def("site.links", "L1", { kind: "site" })],
    results: [passed("site.links", "L1")],
  })

  const unique = verdictOf(report, "site.unique")
  assert.equal(report.ship, false)
  assert.equal(unique.ok, false)
  assert.ok(unique.why.includes("a.html"), unique.why)
  // The titles and the mechanical check are fine, so the overwrite is the one complaint.
  assert.equal(verdictOf(report, "site.titles").ok, true)
  assert.equal(verdictOf(report, "site.mechanical").ok, true)
})

test("an image set ships only when every slot produced a file", () => {
  const spec = imagesSpec([
    { id: "hero", prompt: "a calm gradient", size: { width: 512, height: 512 } },
    { id: "wide", prompt: "the same gradient, wider", size: { width: 1024, height: 512 } },
  ])

  const short = qualityGate({ spec, defs: [], results: [], outputs: ["images/hero.png"] })
  const shortVerdict = verdictOf(short, "images.outputs")
  assert.equal(short.ship, false)
  assert.equal(shortVerdict.ok, false)
  assert.match(shortVerdict.why, /2 slots but 1 output/)

  const silent = qualityGate({ spec, defs: [], results: [] })
  const silentVerdict = verdictOf(silent, "images.outputs")
  assert.equal(silent.ship, false)
  assert.equal(silentVerdict.ok, false)
  assert.match(silentVerdict.why, /no outputs were given/)

  const whole = qualityGate({ spec, defs: [], results: [], outputs: ["images/hero.png", "images/wide.png"] })
  assert.equal(verdictOf(whole, "images.outputs").ok, true)
  assert.equal(whole.ship, true)
})

test("the same spec and the same results give the same report, twice", () => {
  const input: QualityInput = {
    spec: greenDeck(),
    defs: [...deckVisualDefs, def("deck.human", "L3")],
    results: [...deckVisualPassed, skipped("deck.human", "L3", "nobody has looked yet")],
  }
  const first = qualityGate(input)
  const second = qualityGate(input)

  assert.deepEqual(first, second)
  // Two calls, two reports: a cached object would make the comparison above prove nothing about determinism.
  assert.notEqual(first, second)
})

// The acceptance test for B1: one fixture plan, one fake adapter and the real modules around them, with nothing stubbed
// but the adapter itself. The plan.md is written by the plugin's renderer, the promoted page is where promote.ts would
// put it, the adapter's two programs run through `hostRunnerFor` (the one path from an adapter to a program), the
// provenance hashes a real model file, and the same test asks the runner to run a program the adapter never declared.
// Every step is asserted where it happens, so a failure names the stage rather than the pipeline.
test("a fixture plan, a fake deck adapter and the constrained runner produce a shippable deck, and an undeclared program is refused", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "mm-artifact-e2e-"))
  t.after(() => rmSync(sandbox, { recursive: true, force: true }))
  const project = join(sandbox, "project")
  const jobDir = join(sandbox, "job")
  mkdirSync(project)
  mkdirSync(jobDir)

  // 1. A plan.md that promotes one page, built the way the plugin builds it, and a file whose bytes and hash it records.
  const root = artifactsRootFor(project, "job-1")
  const page = await promoted(root, "t1", "deck.html", "<!doctype html><h1>What shipped</h1><p>the release</p>\n")
  const doc = planDoc([page])
  const planMd = renderPlanDoc({ id: "job-1" }, doc)
  const brief = "a deck about the release, handed over from the plan"
  const checks = ["deck.contract", "deck.files", "deck.visual"] as const

  const handoff = await specFromPlan({ planMd, artifactsRoot: root, kind: "deck", job: "job-1", brief, checks: [...checks] })
  assert.deepEqual(handoff.errors, [])
  assert.deepEqual(handoff.warnings, [])
  const spec = handoff.spec
  assert.ok(spec && spec.kind === "deck")
  if (!spec || spec.kind !== "deck") return

  // The spec validates as a deck, and it is the plan's document and the caller's brief that it carries.
  assert.deepEqual(parseSpec("deck", spec).errors, [])
  assert.equal(parsePlanDoc(planMd).doc?.goal, doc.goal)
  assert.equal(spec.brief, brief)
  assert.equal(spec.job, "job-1")
  assert.deepEqual(spec.checks, [...checks])
  assert.deepEqual(spec.slides.map((slide) => [slide.id, slide.title, slide.asset]), [["t1-deck-html", "What shipped", "t1/deck.html"]])
  assert.deepEqual(handoff.used, [{ task: "t1", path: "t1/deck.html", sha256: page.sha256 }])

  // 2. A fake deck adapter. Its allowlist and network declaration are code, and every program it runs goes through the
  // runner it was handed; it never spawns anything itself.
  const runs: HostRunResult[] = []
  let current: DeckSpec | undefined
  const adapter: Adapter<DeckSpec> = {
    kind: "deck",
    name: "fake-deck-e2e",
    version: "0.0.1",
    executables: ["node"],
    // No bubblewrap needed: this test is about the allowlist, the argv array and the job directory, and a networked
    // adapter runs with no wrapper at all (the documented consequence in runner.ts).
    network: true,
    async prepare(input, ctx) {
      current = input
      // The harness stages the validated spec where the runner can point at it; the program below reads it back, so the
      // bytes that reached the renderer are the bytes the handoff returned.
      writeFileSync(join(ctx.jobDir, "spec.json"), `${canonicalJson(input)}\n`)
      const run = await ctx.run.run({
        exe: "node",
        args: [
          "-e",
          `const s = JSON.parse(require("fs").readFileSync("spec.json", "utf8")); require("fs").writeFileSync("prepared.txt", s.brief); console.log("prepared " + s.kind)`,
        ],
      })
      runs.push(run)
      return { notes: [`${input.slides.length} slide(s) prepared`] }
    },
    async render(ctx) {
      const title = current?.slides[0]?.title ?? "untitled"
      writeFileSync(join(ctx.jobDir, "deck.html"), `<!doctype html><h1>${title}</h1>\n`)
      return { outputs: ["deck.html"] }
    },
    async snapshot(ctx) {
      const run = await ctx.run.run({
        exe: "node",
        args: ["-e", `require("fs").writeFileSync("snapshot.png", "png bytes standing in for a screenshot")`],
      })
      runs.push(run)
      return { shots: [{ path: "snapshot.png", label: "slide 1" }] }
    },
    async check(_ctx, defs) {
      return defs.map((entry): CheckResult => ({ id: entry.id, level: entry.level, status: "passed", code: 0 }))
    },
    async cancel() {},
  }

  // 3. The runner is built from the adapter, and the adapter's programs really ran: the files exist and the output
  // arrived, which only a process through the constrained runner can produce.
  const runner = await hostRunnerFor(adapter, { jobDir })
  const ctx: AdapterContext = { jobDir, specPath: join(jobDir, "spec.json"), run: runner, log: () => {} }
  const prepared = await adapter.prepare(spec, ctx)
  assert.deepEqual(prepared.notes, ["1 slide(s) prepared"])
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.passed, true, runs[0]!.stderr)
  assert.equal(runs[0]!.code, 0)
  assert.equal(runs[0]!.stdout.trim(), "prepared deck")
  assert.equal(readFileSync(join(jobDir, "prepared.txt"), "utf8"), brief)

  const rendered = await adapter.render(ctx)
  assert.deepEqual(rendered.outputs, ["deck.html"])
  assert.match(readFileSync(join(jobDir, "deck.html"), "utf8"), /<h1>What shipped<\/h1>/)

  const shots = await adapter.snapshot(ctx)
  assert.deepEqual(shots.shots, [{ path: "snapshot.png", label: "slide 1" }])
  assert.equal(runs.length, 2)
  assert.equal(runs[1]!.passed, true, runs[1]!.stderr)
  assert.ok(statSync(join(jobDir, "snapshot.png")).size > 0, "snapshot.png must carry bytes")

  // 4. The checks: ordered L0 → L1 → L2, with the mechanical result coming from a program that really exited 0.
  const defs: readonly CheckDef[] = [
    def("deck.contract", "L0", { required: true }),
    def("deck.files", "L1", { required: true }),
    def("deck.visual", "L2", { required: true }),
  ]
  const l0: CheckResult = { id: "deck.contract", level: "L0", status: "passed", code: 0 }
  const files = await runner.run({ exe: "node", args: ["-e", "process.exit(0)"] })
  assert.equal(files.passed, true)
  assert.equal(files.code, 0)
  const l1: CheckResult = { id: "deck.files", level: "L1", status: files.passed ? "passed" : "failed", code: files.code }
  // A visual check is browser work (B3-T4), so this one is synthetic: the evaluation below is about ordering and exit
  // codes, not about whether a screenshot was looked at.
  const l2: CheckResult = { id: "deck.visual", level: "L2", status: "passed", code: 0 }
  const results: readonly CheckResult[] = [l1, l2, l0]

  assert.deepEqual(checkPlan(defs, []).next.map((entry) => entry.id), ["deck.contract"])
  assert.deepEqual(checkPlan(defs, [l0]).next.map((entry) => entry.id), ["deck.files"])
  assert.deepEqual(checkPlan(defs, [l0, l1]).next.map((entry) => entry.id), ["deck.visual"])
  assert.deepEqual(checkPlan(defs, results), { next: [], skip: [] })

  const coverage = evaluate(defs, results)
  assert.equal(coverage.ok, true, [...coverage.invalid, ...coverage.missing].join("; "))
  assert.deepEqual(coverage.results.map((entry) => [entry.id, entry.code]), [
    ["deck.contract", 0],
    ["deck.files", 0],
    ["deck.visual", 0],
  ])

  // 5. The manifest is written from the files on disk and verifies against them.
  const manifest = await manifestOf(jobDir, [
    { path: "deck.html", source: "tool" },
    { path: "snapshot.png", source: "tool" },
  ])
  assert.deepEqual(manifest.assets.map((entry) => entry.path), ["deck.html", "snapshot.png"])
  assert.equal(manifest.assets[0]!.sha256, await sha256File(join(jobDir, "deck.html")))
  assert.deepEqual(await verifyManifest(jobDir, manifest), { ok: true, missing: [], changed: [], outside: [] })

  // 6. Provenance: the hash is the model file's own, the spec hash is the spec's, and the record survives the round trip.
  const modelFile = join(project, "model.bin")
  writeFileSync(modelFile, "a few bytes standing in for a checkpoint\n")
  const model = await modelProvenance({
    name: "fake-deck-model",
    version: "0.0.1",
    file: modelFile,
    license: "Apache-2.0",
    territory: "EU",
  })
  assert.deepEqual(model.errors, [])
  assert.ok(model.model)
  assert.equal(model.model.verified, true)
  assert.equal(model.model.sha256, await sha256File(modelFile))

  const record = buildProvenance({
    tool: { name: "fake-deck", version: "0.0.1", license: "Apache-2.0", territory: "EU" },
    model: model.model,
    seed: 7,
    inputs: [{ path: handoff.used[0]!.path, sha256: handoff.used[0]!.sha256 }],
    spec: { kind: "deck", version: specVersionOf("deck"), sha256: specHash(spec) },
    createdAt: "2026-11-15T00:00:00.000Z",
  })
  assert.equal(record.spec.sha256, specHash(spec))
  await writeProvenance(jobDir, record)
  assert.deepEqual(await readProvenance(jobDir), { provenance: record, errors: [] })

  // 7. The gate ships it: every verdict passes, including the visual one the L2 result stands behind.
  const report = qualityGate({ spec, defs, results, outputs: ["deck.html"] })
  assert.equal(report.ship, true, report.verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.why).join("; "))
  assert.deepEqual(report.warnings, [])

  // 8. And the same runner refuses a program the adapter never declared, before anything is started.
  const pwned = join(jobDir, "pwned")
  const refused = await runner.run({ exe: "sh", args: ["-c", `touch ${pwned}`] })
  assert.equal(refused.passed, false)
  assert.equal(refused.code, -1)
  assert.ok(refused.refused, "a refusal must carry a sentence")
  assert.ok(refused.refused.includes("sh") && refused.refused.includes("allowlist"), refused.refused)
  assert.equal(refused.stdout, "")
  assert.equal(existsSync(pwned), false, "the refused shell must not have run")
})


