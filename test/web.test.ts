// B4: the site adapter. The spec's build contract, what the files say, what each check makes of a probe report, the
// adapter's calls to the runner, and one real pass through bubblewrap and Chromium where the machine has both.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { encodePng, solid, tempDir } from "./harness.ts"

import type { HostRunInput, HostRunResult, HostRunner } from "../packages/artifact/src/adapter.ts"
import { findChromium } from "../packages/artifact/src/chromium.ts"
import { parseSpec, type SiteSpec } from "../packages/artifact/src/spec.ts"
import { hostRunnerFor } from "../packages/artifact/src/runner.ts"
import { DEFAULT_BUDGET_KB, PROBE_DIR, scanSite, siteDirs, WEB_CHECKS, webAdapter, webResults, type ProbeReport, type ProbeView } from "../packages/artifact/src/adapters/web.ts"

const ROOT = tempDir("mm-web-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

const site = (extra: Partial<SiteSpec> = {}): SiteSpec => ({
  kind: "site",
  version: 2,
  job: "job-1",
  brief: "a small site",
  pages: [{ path: "index.html", title: "Home" }, { path: "about.html", title: "About" }],
  ...extra,
})

let n = 0
function job(files: Record<string, string>): string {
  const dir = join(ROOT, `job-${++n}`)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const HOME = `<!doctype html><html lang="en"><head><title>Home</title><link rel="stylesheet" href="css/site.css"></head>
<body><main><h1>Home</h1><a href="about">About</a> <a href="/">Self</a> <a href="#top">Top</a> <a href="https://example.org/x">Out</a>
<img src="img/logo.png" srcset="img/logo.png 1x, img/logo@2x.png 2x" alt="logo"></main></body></html>`

test("a site spec carries one build contract, a budget and a brand, and refuses what a shell would read", () => {
  assert.deepEqual(parseSpec("site", site({ root: "web", build: { script: "build", out: "dist" }, budget: { kb: 800 }, brand: { colors: ["#123456"], fonts: ["Inter"] } })).errors, [])
  const bad = parseSpec("site", site({ build: { script: "build; rm -rf /", out: "/dist" } as never, budget: { kb: 0 }, brand: { colors: ["red"] } }))
  assert.match(bad.errors.join("\n"), /build\.script: expected an npm script name/)
  assert.match(bad.errors.join("\n"), /build\.out: a path must be relative/)
  assert.match(bad.errors.join("\n"), /budget\.kb: expected a positive number/)
  assert.match(bad.errors.join("\n"), /brand\.colors\[0\]: expected a hex colour/)
  assert.match(parseSpec("site", { ...site(), version: 1 }).errors.join(), /version/)
})

test("the files say which pages exist, where every local reference lands, and what goes elsewhere", () => {
  const dir = job({ "index.html": HOME, "about.html": "<title>About</title><a href='index.html'>x</a><a href='gone.html'>y</a>", "css/site.css": "", "img/logo.png": "png" })
  const project = scanSite(site(), dir)
  assert.deepEqual(project.pages.map((p) => [p.path, p.exists, p.title]), [["index.html", true, "Home"], ["about.html", true, "About"]])
  const byRef = Object.fromEntries(project.links.map((l) => [`${l.page} ${l.ref}`, l.target ?? null]))
  assert.equal(byRef["index.html about"], "about.html", "a page written without .html")
  assert.equal(byRef["index.html /"], "index.html", "the root is its index")
  assert.equal(byRef["index.html #top"], "index.html")
  assert.equal(byRef["index.html img/logo@2x.png"], null, "a srcset candidate is a reference too")
  assert.equal(byRef["about.html gone.html"], null)
  assert.deepEqual(project.external, ["https://example.org/x"])
  assert.ok(project.files.includes("css/site.css"))
})

test("a built site is served from what its script writes, inside its root", () => {
  const dir = job({ "web/dist/index.html": "<title>x</title>", "web/package.json": "{}" })
  const dirs = siteDirs(site({ root: "web", build: { script: "build", out: "dist" }, pages: [{ path: "index.html", title: "x" }] }), dir)
  assert.equal(dirs.root, join(dir, "web"))
  assert.equal(dirs.served, join(dir, "web", "dist"))
})

const view = (extra: Partial<ProbeView> = {}): ProbeView => ({ width: 1280, status: 200, console: [], errors: [], failed: [], external: [], overflow: false, bytes: 50_000, ...extra })

test("each browser rule reads its part of the report, and no report fails them all", () => {
  const dir = job({ "index.html": "<title>Home</title>", "about.html": "<title>About</title>" })
  const project = scanSite(site(), dir)
  const shot = join(dir, "shot.png")
  writeFileSync(shot, encodePng(64, 64, 6, solid([255, 255, 255, 255])))
  const report: ProbeReport = {
    pages: [
      { path: "index.html", views: [view({ width: 390, overflow: true, console: ["Failed to load resource: 404", "boom"], failed: ["/x.png: HTTP 404"], shot: "shot.png" })], axe: [{ id: "image-alt", impact: "critical", help: "Images must have alternative text", nodes: 1 }] },
      { path: "about.html", views: [view({ bytes: (DEFAULT_BUDGET_KB + 1) * 1024, shot: "shot.png" })], axe: [{ id: "region", impact: "moderate", help: "landmarks", nodes: 2 }] },
    ],
  }
  const by = Object.fromEntries(webResults({ spec: site(), project, report, jobDir: dir }, WEB_CHECKS).map((r) => [r.id, r]))
  assert.equal(by["site.contract"]!.status, "skipped", "the spec parse owns L0")
  assert.equal(by["site.pages"]!.status, "passed")
  assert.equal(by["site.build"]!.status, "passed", "a static site has nothing to build")
  assert.equal(by["site.load"]!.status, "passed")
  assert.match(by["site.console"]!.reason!, /index\.html at 390px: boom$/, "a failed load is the requests rule's, not counted twice")
  assert.match(by["site.requests"]!.reason!, /x\.png: HTTP 404/)
  assert.match(by["site.overflow"]!.reason!, /390px: wider than the window/)
  assert.match(by["site.a11y"]!.reason!, /image-alt \(critical/)
  assert.match(by["site.weight"]!.reason!, /about\.html .*the budget is 1500 KB/)
  assert.equal(by["site.snapshot"]!.status, "passed")
  assert.match(by["site.blank"]!.reason!, /blank/)

  const none = webResults({ spec: site(), project, probeProblem: "no browser", jobDir: dir }, WEB_CHECKS)
  for (const r of none.filter((r) => !["site.contract", "site.pages", "site.links", "site.build"].includes(r.id))) {
    assert.equal(r.status, "failed", `${r.id} does not pass without a look`)
    assert.match(r.reason!, /no browser/)
  }
  const minorOnly = webResults({ spec: site(), project, report: { pages: [{ path: "index.html", views: [view()], axe: [{ id: "region", impact: "moderate", help: "landmarks", nodes: 1 }] }] }, jobDir: dir }, WEB_CHECKS.filter((d) => d.id === "site.a11y"))
  assert.equal(minorOnly[0]!.status, "passed")
  assert.match(minorOnly[0]!.output!, /also found: index\.html: region/)
})

// A runner that answers like the probe would: the report and one shot written into the job.
function fakeRunner(jobDir: string, write: (input: HostRunInput) => void = () => {}): HostRunner & { calls: HostRunInput[] } {
  const calls: HostRunInput[] = []
  const ok: HostRunResult = { passed: true, code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }
  return {
    calls,
    async run(input) {
      calls.push(input)
      write(input)
      return ok
    },
    cancel() {},
  }
}

test("the adapter builds with npm, probes with node from the job, and reads the report back", async () => {
  const dir = job({ "web/package.json": "{}", "web/dist/index.html": "<title>x</title>" })
  const spec = site({ root: "web", build: { script: "build", out: "dist" }, pages: [{ path: "index.html", title: "x" }] })
  const runner = fakeRunner(dir, (input) => {
    if (input.exe !== "node") return
    const shot = join(dir, "shots", "index-1280.png")
    mkdirSync(join(dir, "shots"), { recursive: true })
    writeFileSync(shot, encodePng(32, 32, 6, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255])))
    writeFileSync(join(dir, PROBE_DIR, "report.json"), JSON.stringify({ pages: [{ path: "index.html", views: [view({ shot })], axe: [] }] }))
  })
  const adapter = webAdapter({ chromium: "/usr/bin/chromium" })
  const ctx = { jobDir: dir, specPath: "", run: runner, log: () => {} }
  await adapter.prepare(spec, ctx)
  assert.equal(existsSync(join(dir, PROBE_DIR, "web-probe.mjs")), true, "the probe is laid down in the job")
  await adapter.render(ctx)
  assert.deepEqual([runner.calls[0]!.exe, runner.calls[0]!.args, runner.calls[0]!.cwd], ["npm", ["run", "build"], join(dir, "web")])
  assert.equal(runner.calls[0]!.network, undefined, "the build stays wrapped")
  const shots = await adapter.snapshot(ctx)
  assert.deepEqual(shots.shots, [{ path: "shots/index-1280.png", label: "index.html at 1280px" }])
  const probe = runner.calls[1]!
  assert.equal(probe.exe, "node")
  assert.deepEqual(probe.args, [".probe/web-probe.mjs", "check", "web/dist", ".probe/report.json", "shots", "index.html"])
  assert.equal(probe.network, undefined, "the probe stays wrapped")
  assert.ok(probe.env?.NODE_PATH?.includes("node_modules"))
  assert.equal(probe.env?.WEB_PROBE_CHROMIUM, "/usr/bin/chromium")
  const results = await adapter.check(ctx, WEB_CHECKS)
  assert.equal(runner.calls.length, 2, "one browser pass serves the snapshot and the checks")
  assert.deepEqual(results.filter((r) => r.status === "failed").map((r) => r.id), [])
})

test("without a browser the adapter says so instead of looking", async () => {
  const dir = job({ "index.html": "<title>x</title>" })
  const runner = fakeRunner(dir)
  const adapter = webAdapter({ chromium: null })
  const ctx = { jobDir: dir, specPath: "", run: runner, log: () => {} }
  await adapter.prepare(site({ pages: [{ path: "index.html", title: "x" }] }), ctx)
  await adapter.render(ctx)
  const results = await adapter.check(ctx, WEB_CHECKS.filter((d) => d.id === "site.load"))
  assert.match(results[0]!.reason!, /no browser is installed/)
  assert.equal(runner.calls.length, 0)
})

const chromium = findChromium()
const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].some((p) => existsSync(p))
test("a real pass: bubblewrap, Chromium and axe find what is wrong with a page", { skip: !chromium || !bwrap ? "needs Chromium and bubblewrap" : false, timeout: 120_000 }, async () => {
  const dir = job({
    "index.html": `<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><img src="gone.png"><div style="width:2000px">wide</div><script>console.error("boom")</script></main></body></html>`,
    "about.html": `<!doctype html><html lang="en"><head><title>About</title></head><body><main><h1>About</h1><p>Text.</p><a href="index.html">Home</a></main></body></html>`,
  })
  const adapter = webAdapter()
  const run = await hostRunnerFor(adapter, { jobDir: dir })
  const ctx = { jobDir: dir, specPath: "", run, log: () => {} }
  await adapter.prepare(site(), ctx)
  await adapter.render(ctx)
  const shots = await adapter.snapshot(ctx)
  assert.equal(shots.shots.length, 6, "two pages at three widths")
  const by = Object.fromEntries((await adapter.check(ctx, WEB_CHECKS)).map((r) => [r.id, r]))
  assert.equal(by["site.load"]!.status, "passed", by["site.load"]!.reason)
  assert.match(by["site.console"]!.reason!, /boom/)
  assert.match(by["site.requests"]!.reason!, /gone\.png: HTTP 404/)
  assert.match(by["site.overflow"]!.reason!, /index\.html at 390px/)
  assert.match(by["site.a11y"]!.reason!, /image-alt/)
  assert.equal(by["site.blank"]!.status, "passed")
  assert.doesNotMatch(by["site.overflow"]!.reason!, /about\.html/)
})
