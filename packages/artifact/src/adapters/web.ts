// The site adapter (B4): a static site, or one an npm script builds, served from its own directory and checked in a real
// browser at three widths. The files say what they can (web-project.ts), the browser probe says the rest
// (web-probe.mjs), and web-checks.ts turns both into check results.
//
// Like every adapter it starts nothing itself. The build is `npm run <script>` and the probe is `node
// .probe/web-probe.mjs`, both asked of the host runner, which runs them under bubblewrap with the network unshared: a
// build that needs packages has them installed already (the worker's job, in its worktree), and a page that reaches out
// to another site is reported, not followed. Only the human's door, `openEditor`, asks for the network, because the
// user's browser has to reach the server it starts.
//
// The probe is copied into the job on every prepare, since the runner refuses an argument naming a path outside it; its
// dependencies (Playwright, axe) are this package's own and reach it through NODE_PATH, and Chromium is the one
// `findChromium` finds for the plugin's other browser tools.

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { Adapter, AdapterContext, HostRunner } from "../adapter.ts"
import type { CheckDef } from "../checks.ts"
import { findChromium } from "../chromium.ts"
import type { SiteSpec } from "../spec.ts"
import { freePort, hyperframesServe, outputOf, tailOf } from "./hyperframes.ts"
import { webResults, type BuildOutcome, type ProbeReport } from "./web-checks.ts"
import { PROBE_DIR, probeDir, scanSite, SHOTS_DIR, type SiteProject } from "./web-project.ts"

export * from "./web-checks.ts"
export * from "./web-project.ts"

export const WEB_ENV_NAMES = ["NODE_PATH", "WEB_PROBE_CHROMIUM"] as const
const PROBE_FILE = "web-probe.mjs"
const REPORT_FILE = "report.json"
const BUILD_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 5 * 60_000

const require = createRequire(import.meta.url)

// The node_modules directories Playwright and axe were installed in, for NODE_PATH. Workspaces may hoist one and not
// the other, so each is resolved on its own.
function moduleDirs(): string[] {
  const dirs = new Set<string>()
  for (const name of ["playwright-core/package.json", "axe-core/package.json"]) {
    try {
      const file = require.resolve(name)
      dirs.add(resolve(dirname(file), "..")) // <node_modules>/<name>/package.json → <node_modules>
    } catch {
      // not installed: the probe says so when it starts
    }
  }
  return [...dirs]
}

export interface WebAdapterOptions {
  readonly chromium?: string | null // injected by tests; undefined means "find one"
}

export function webAdapter(options: WebAdapterOptions = {}): Adapter<SiteSpec> {
  let runner: HostRunner | undefined
  let spec: SiteSpec | undefined
  let project: SiteProject | undefined
  let build: BuildOutcome | undefined
  let report: ProbeReport | undefined
  let probeProblem: string | undefined
  let looked = false

  const asked = (): SiteSpec => {
    if (!spec) throw new Error("site: the adapter ran a step before prepare, so there is no spec to work on")
    return spec
  }

  const env = (): Record<string, string> => {
    const chromium = options.chromium === undefined ? findChromium() : options.chromium
    return { NODE_PATH: moduleDirs().join(":"), ...(chromium ? { WEB_PROBE_CHROMIUM: chromium } : {}) }
  }

  // One browser pass for the snapshot and the checks alike, so both speak about the same page.
  const look = async (ctx: AdapterContext): Promise<void> => {
    if (looked) return
    looked = true
    const current = scanSite(asked(), ctx.jobDir)
    project = current
    const pages = current.pages.filter((p) => p.exists).map((p) => p.path)
    if (pages.length === 0) {
      probeProblem = "no page the spec names exists, so there was nothing to open"
      return
    }
    const chromium = options.chromium === undefined ? findChromium() : options.chromium
    if (!chromium) {
      probeProblem = "no browser is installed where the plugin runs (chromium, google-chrome or Playwright's chromium)"
      return
    }
    const job = resolve(ctx.jobDir)
    const reportPath = join(PROBE_DIR, REPORT_FILE)
    rmSync(join(job, reportPath), { force: true })
    rmSync(join(job, SHOTS_DIR), { recursive: true, force: true })
    const result = await ctx.run.run({
      exe: "node",
      args: [join(PROBE_DIR, PROBE_FILE), "check", relative(job, current.served) || ".", reportPath, SHOTS_DIR, ...pages],
      cwd: job,
      env: env(),
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (!result.passed) {
      probeProblem = result.refused ?? (tailOf(outputOf(result)) || `the probe exited with ${result.code}`)
      ctx.log(`site probe: ${probeProblem}`)
      return
    }
    try {
      const raw = JSON.parse(readFileSync(join(job, reportPath), "utf8")) as ProbeReport
      // Shots as the interface wants them: relative to the job.
      report = { ...raw, pages: raw.pages.map((p) => ({ ...p, views: p.views.map((v) => (v.shot ? { ...v, shot: relative(job, v.shot) } : v)) })) }
    } catch (error) {
      probeProblem = `the probe wrote no readable report: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  return {
    kind: "site",
    name: "static",
    version: "0.1.0",
    executables: ["node", "npm"],
    // For openEditor alone; the build and the probe leave it unset and stay wrapped.
    network: true,
    env: WEB_ENV_NAMES,

    // The spec's directories must exist inside the job, and the probe is laid down fresh.
    async prepare(input, ctx) {
      runner = ctx.run
      spec = input
      looked = false
      report = undefined
      probeProblem = undefined
      build = undefined
      const scanned = scanSite(input, ctx.jobDir)
      project = scanned
      const dir = probeDir(ctx.jobDir)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), PROBE_FILE), join(dir, PROBE_FILE))
      const notes = [
        input.build ? `built with npm run ${input.build.script}, served from ${input.build.out}` : "a static site, served as it is",
        ...(scanned.external.length ? [`${scanned.external.length} links to other sites, which the checks do not follow`] : []),
      ]
      for (const note of notes) ctx.log(note)
      return { notes }
    },

    // A static site is its files; a built one is what its script writes. The outputs are the served files.
    async render(ctx) {
      const current = asked()
      if (current.build) {
        const { root } = scanSite(current, ctx.jobDir)
        const result = await ctx.run.run({ exe: "npm", args: ["run", current.build.script], cwd: root, timeoutMs: BUILD_TIMEOUT_MS })
        build = { ran: result.refused === undefined, passed: result.passed, output: result.refused ?? outputOf(result) }
        if (!result.passed) ctx.log(`npm run ${current.build.script}: ${tailOf(build.output)}`)
      } else {
        build = { ran: false, passed: true, output: "" }
      }
      project = scanSite(current, ctx.jobDir)
      looked = false
      return { outputs: project.files }
    },

    async snapshot(ctx) {
      await look(ctx)
      const shots = (report?.pages ?? []).flatMap((p) => p.views.flatMap((v) => (v.shot ? [{ path: v.shot, label: `${p.path} at ${v.width}px` }] : [])))
      return { shots }
    },

    async check(ctx, defs: readonly CheckDef[]) {
      await look(ctx)
      return webResults({ spec: asked(), project: project ?? scanSite(asked(), ctx.jobDir), ...(build ? { build } : {}), ...(report ? { report } : {}), ...(probeProblem ? { probeProblem } : {}), jobDir: ctx.jobDir }, defs)
    },

    // The human's door: the probe's server on a free port, with the network, so the user's own browser reaches it.
    async openEditor(ctx) {
      const current = project ?? scanSite(asked(), ctx.jobDir)
      const job = resolve(ctx.jobDir)
      const port = await freePort("site")
      const started = await hyperframesServe(ctx.run, () => ctx.run.run({
        exe: "node",
        args: [join(PROBE_DIR, PROBE_FILE), "serve", relative(job, current.served) || ".", String(port)],
        cwd: job,
        network: true,
        env: env(),
      }), port, "site preview")
      if (!started.started) throw new Error(started.output)
      ctx.log(`site preview on http://127.0.0.1:${port}/`)
    },

    cancel() {
      runner?.cancel()
    },
  }
}
