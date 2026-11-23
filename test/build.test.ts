// buildArtifact (packages/artifact/src/build.ts): a spec file in, the adapter's steps run, a report out. A fake adapter
// and runner stand in for HyperFrames; test/deck.test.ts runs the real engine.

import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import type { Adapter, HostRunner } from "../packages/artifact/src/adapter.ts"
import { buildArtifact, formatBuild } from "../packages/artifact/src/build.ts"
import { DECK_CHECKS } from "../packages/artifact/src/adapters/deck-checks.ts"
import { SKIPPED_CODE } from "../packages/artifact/src/checks.ts"
import { ROLES } from "../packages/state/src/roles.ts"

const ROOT = tempDir("mm-build-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const DECK = { kind: "deck", version: 2, job: "t", brief: "a test", slides: [{ id: "a", title: "A", body: "b", notes: "n" }] }

let n = 0
function specFile(value: unknown, name = "deck.json"): string {
  const dir = join(ROOT, `job-${++n}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
  return path
}

const runner: HostRunner = { run: async () => ({ passed: true, code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }), cancel: () => undefined }

function fake(o: { failAt?: string; failCheck?: string; present?: boolean } = {}) {
  const seen: string[] = []
  const adapter = {
    kind: "deck", name: "fake", version: "1", executables: ["hyperframes"], network: false,
    async prepare(_spec: unknown, ctx: { jobDir: string }) {
      seen.push(`prepare ${ctx.jobDir}`)
      if (o.failAt === "prepare") throw new Error("no engine")
      return { notes: ["Fake 1.0 made this"] }
    },
    async render() {
      seen.push("render")
      if (o.failAt === "render") throw new Error("render broke")
      return { outputs: ["index.html"] }
    },
    async snapshot() {
      seen.push("snapshot")
      return { shots: [{ path: "s/a.png", label: "a" }] }
    },
    async check(_ctx: unknown, defs: readonly { id: string; level: string }[]) {
      seen.push(`check ${defs.length}`)
      return defs.map((d) =>
        d.id === o.failCheck ? { id: d.id, level: d.level, status: "failed", code: 1, reason: "text leaves its box" }
        : d.id === "deck.vlm" ? { id: d.id, level: d.level, status: "skipped", code: SKIPPED_CODE, reason: "no vision model" }
        : { id: d.id, level: d.level, status: "passed", code: 0 })
    },
    ...(o.present ? { async openEditor(ctx: { log: (l: string) => void }) { ctx.log("hyperframes present is listening on port 4242") } } : {}),
  } as unknown as Adapter
  return { adapter, seen }
}

test("a spec that is not JSON, of no known kind, or invalid stops at the spec with the reason", async () => {
  assert.match((await buildArtifact(specFile("{ nope"))).failed?.reason ?? "", /not readable JSON/)
  assert.match((await buildArtifact(specFile({ kind: "poem" }))).failed?.reason ?? "", /kind must be one of deck, video, site, images/)
  const bad = await buildArtifact(specFile({ ...DECK, slides: [{ id: "a" }, { id: "a" }] }))
  assert.equal(bad.failed?.step, "spec")
  assert.equal(bad.kind, "deck")
})

test("the steps run in order in the spec's directory, and the report says what passed, failed and was skipped", async () => {
  const path = specFile(DECK)
  const { adapter, seen } = fake({ failCheck: "deck.overflow" })
  const r = await buildArtifact(path, { adapter, runner })
  assert.deepEqual(seen, [`prepare ${join(ROOT, `job-${n}`)}`, "render", "snapshot", `check ${DECK_CHECKS.filter((d) => d.run === "argv").length}`])
  assert.equal(r.ok, false)
  const text = formatBuild(r)
  assert.match(text, /^deck: built, but checks failed \(\d+ passed, 1 failed, 1 skipped\)/)
  assert.match(text, /FAILED deck\.overflow: text leaves its box/)
  assert.match(text, /skipped deck\.vlm: no vision model/)
  assert.match(text, /Fix the spec or its content/)
})

test("a step that throws ends the build there, named", async () => {
  const r = await buildArtifact(specFile(DECK), { adapter: fake({ failAt: "render" }).adapter, runner })
  assert.deepEqual(r.failed, { step: "render", reason: "render broke" })
  assert.match(formatBuild(r), /^deck: stopped at render: render broke/)
})

test("present starts the presenter only after every check passed, and says where", async () => {
  const passing = await buildArtifact(specFile(DECK), { adapter: fake({ present: true }).adapter, runner, present: true })
  assert.equal(passing.ok, true)
  assert.equal(passing.presented?.url, "http://127.0.0.1:4242/")
  assert.match(formatBuild(passing), /presenting at http:\/\/127\.0\.0\.1:4242\//)
  const failing = await buildArtifact(specFile(DECK), { adapter: fake({ present: true, failCheck: "deck.notes" }).adapter, runner, present: true })
  assert.equal(failing.presented, undefined, "a failing deck is not shown")
})

test("only roles that may write may build an artifact", () => {
  for (const role of ROLES) {
    const writes = !role.rules.some((r) => r.action === "edit" && r.resource === "*" && r.effect === "deny")
    const builds = !role.rules.some((r) => r.action === "make_artifact" && r.resource === "*" && r.effect === "deny")
    assert.equal(builds, writes, role.agent)
  }
})
