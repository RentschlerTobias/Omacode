// The site's checks (B4-T3/T4).
//
// A site is worth showing when what the files can tell is true — every page the spec names exists, every local link
// and reference lands on a file, the build (if there is one) exited zero — and when what only a browser can tell is
// true at a phone's, a tablet's and a desktop's width: the page loads, throws nothing and logs no error, everything it
// asks for is there, nothing is wider than the window, axe finds nothing serious or critical, the page stays inside its
// weight budget, and every screenshot has something on it.
//
// Like the deck's checks, this is a mapping of values: `webResults` gets the spec, the scanned project, the probe's report
// and the build's result, and says what follows. A rule whose input is missing fails; it does not pass. One rule opens
// files: `site.blank` reads the screenshots, since a pixel does not travel through a report.
//
// Lighthouse is not part of this (the user's decision, 2026-11-21): axe covers accessibility, the probe covers weight
// and errors, and a vision review is the L2 judgement a later step adds.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { CONTRACT_CHECKS, SKIPPED_CODE, type CheckDef, type CheckResult } from "../checks.ts"
import { blankFrame, readPng } from "../png.ts"
import type { SiteSpec } from "../spec.ts"
import { many } from "./hyperframes.ts"
import type { SiteProject } from "./web-project.ts"

const SITE_CONTRACT = CONTRACT_CHECKS.filter((def) => def.kind === "site")

const def = (id: string, level: "L1" | "L2", title: string): CheckDef => ({ id, level, kind: "site", title, run: "argv", required: true })

export const WEB_CHECKS: readonly CheckDef[] = [
  ...SITE_CONTRACT,
  def("site.pages", "L1", "every page the spec names exists"),
  def("site.links", "L1", "every local link and reference lands on a file"),
  def("site.build", "L1", "the build ran and exited zero"),
  def("site.load", "L1", "every page loads at every width"),
  def("site.console", "L1", "no page throws or logs an error"),
  def("site.requests", "L1", "everything a page asks for is there"),
  def("site.overflow", "L1", "no page is wider than the window"),
  def("site.a11y", "L1", "axe finds nothing serious or critical"),
  def("site.weight", "L1", "every page stays inside its weight budget"),
  def("site.snapshot", "L2", "every page has a screenshot at every width"),
  def("site.blank", "L2", "no screenshot is blank"),
]

// A page's weight without a budget in the spec: 1.5 MB, a generous ceiling for a landing page on a phone connection.
export const DEFAULT_BUDGET_KB = 1500
// The share of one colour that makes a screenshot blank (png.ts blankFrame); a deck uses 0.995.
export const BLANK_SHARE = 0.9995
// axe's impacts that fail the check; "moderate" and "minor" are reported in the passing text.
const BLOCKING_IMPACTS = new Set(["serious", "critical"])

export interface ProbeView {
  readonly width: number
  readonly status: number
  readonly console: readonly string[]
  readonly errors: readonly string[]
  readonly failed: readonly string[]
  readonly external: readonly string[]
  readonly overflow: boolean
  readonly bytes: number
  readonly shot?: string
}

export interface ProbeReport {
  readonly chromium?: string
  readonly pages: readonly {
    readonly path: string
    readonly views: readonly ProbeView[]
    readonly axe?: readonly { readonly id: string; readonly impact: string; readonly help: string; readonly nodes: number }[]
  }[]
}

export interface BuildOutcome {
  readonly ran: boolean // false for a static site: there was nothing to build
  readonly passed: boolean
  readonly output: string
}

export interface WebResultInput {
  readonly spec: SiteSpec
  readonly project: SiteProject
  readonly build?: BuildOutcome
  readonly report?: ProbeReport
  readonly probeProblem?: string // why there is no report: no browser, the probe crashed
  readonly jobDir: string
}

type Verdict = { readonly status: "passed" | "failed" | "skipped"; readonly text: string }
const pass = (text: string): Verdict => ({ status: "passed", text })
const fail = (text: string): Verdict => ({ status: "failed", text })

const FEW = 3
const few = (items: readonly string[]): string => `${items.slice(0, FEW).join("; ")}${items.length > FEW ? ` and ${items.length - FEW} more` : ""}`

// Every (page, width) the report has, with the page's path; a missing report is one failure for every browser rule.
function views(input: WebResultInput): { page: string; view: ProbeView }[] | Verdict {
  if (!input.report) return fail(`the browser did not look: ${input.probeProblem ?? "no report"}`)
  return input.report.pages.flatMap((p) => p.views.map((view) => ({ page: p.path, view })))
}

// A browser rule over every view: `bad` names what is wrong with one view, or nothing.
function overViews(input: WebResultInput, bad: (page: string, view: ProbeView) => string | undefined, ok: string): Verdict {
  const all = views(input)
  if (!Array.isArray(all)) return all
  if (all.length === 0) return fail("the browser looked at no page")
  const problems = all.flatMap(({ page, view }) => {
    const why = bad(page, view)
    return why ? [`${page} at ${view.width}px: ${why}`] : []
  })
  return problems.length ? fail(few(problems)) : pass(ok)
}

function verdictFor(id: string, input: WebResultInput): Verdict | undefined {
  const { project, spec } = input
  switch (id) {
    case "site.pages": {
      const missing = project.pages.filter((p) => !p.exists).map((p) => p.path)
      return missing.length ? fail(`missing: ${few(missing)}`) : pass(`${many(project.pages.length, "page")} present`)
    }
    case "site.links": {
      const dead = project.links.filter((l) => l.target === undefined).map((l) => `${l.page} → ${l.ref}`)
      const out = project.external.length ? `; ${many(project.external.length, "link")} to other sites not followed` : ""
      return dead.length ? fail(`lands nowhere: ${few(dead)}`) : pass(`${many(project.links.length, "local reference")} resolve${out}`)
    }
    case "site.build": {
      if (!spec.build) return pass("a static site: nothing to build")
      if (!input.build?.ran) return fail(`npm run ${spec.build.script} did not run`)
      return input.build.passed ? pass(`npm run ${spec.build.script} exited zero`) : fail(`npm run ${spec.build.script} failed: ${input.build.output.slice(-400)}`)
    }
    case "site.load":
      return overViews(input, (_, v) => (v.status >= 200 && v.status < 400 ? undefined : v.errors.find((e) => e.startsWith("could not load")) ?? `HTTP ${v.status}`), "every page loads at every width")
    case "site.console":
      // A failed load also shows up as a console line; it is the requests rule's to report, so it is not counted twice.
      return overViews(input, (_, v) => {
        const said = [...v.errors.filter((e) => !e.startsWith("could not load")), ...v.console.filter((c) => !c.startsWith("Failed to load resource"))]
        return said.length ? few(said) : undefined
      }, "no page throws or logs an error")
    case "site.requests":
      return overViews(input, (_, v) => (v.failed.length ? few(v.failed) : undefined), "everything the pages ask for is there")
    case "site.overflow":
      return overViews(input, (_, v) => (v.overflow ? "wider than the window (horizontal scroll)" : undefined), "no page is wider than the window")
    case "site.a11y": {
      if (!input.report) return fail(`the browser did not look: ${input.probeProblem ?? "no report"}`)
      const blocking: string[] = []
      const minor: string[] = []
      for (const p of input.report.pages) {
        if (!p.axe) {
          blocking.push(`${p.path}: axe did not run`)
          continue
        }
        for (const v of p.axe) (BLOCKING_IMPACTS.has(v.impact) ? blocking : minor).push(`${p.path}: ${v.id} (${v.impact}, ${many(v.nodes, "element")}) ${v.help}`)
      }
      if (blocking.length) return fail(few(blocking))
      return pass(minor.length ? `nothing serious or critical; also found: ${few(minor)}` : "axe found nothing")
    }
    case "site.weight": {
      const kb = spec.budget?.kb ?? DEFAULT_BUDGET_KB
      return overViews(input, (_, v) => (v.bytes / 1024 > kb ? `${Math.round(v.bytes / 1024)} KB, the budget is ${kb} KB` : undefined), `every page is under ${kb} KB`)
    }
    case "site.snapshot":
      return overViews(input, (_, v) => (v.shot ? undefined : "no screenshot"), "a screenshot of every page at every width")
    case "site.blank":
      return overViews(input, (_, v) => {
        if (!v.shot) return "no screenshot to look at"
        let bytes: Uint8Array
        try {
          bytes = readFileSync(v.shot.startsWith("/") ? v.shot : join(input.jobDir, v.shot))
        } catch {
          return "the screenshot cannot be read"
        }
        const image = readPng(bytes)
        if ("unsupported" in image) return `the screenshot is no PNG this package reads: ${image.unsupported}`
        // A page is mostly background by design, unlike a slide: one heading on a white desktop page covers well under
        // half a percent. So only a frame that is all but one colour counts as blank here.
        const b = blankFrame(image, { threshold: BLANK_SHARE })
        return b.blank ? `blank: ${b.why}` : undefined
      }, "every screenshot has something on it")
    default:
      return undefined
  }
}

// One result per definition, in the order asked. A definition without a rule here is a skip that says so, never a pass.
export function webResults(input: WebResultInput, defs: readonly CheckDef[]): readonly CheckResult[] {
  return defs.map((d): CheckResult => {
    const verdict = d.run === "argv" ? verdictFor(d.id, input) : undefined
    if (verdict === undefined) {
      const why = d.run === "argv" ? `no rule in the site adapter produces ${d.id}` : `${d.id} is produced by the spec parse (${d.level}, run: "${d.run}"), not by the site adapter`
      return { id: d.id, level: d.level, status: "skipped", code: SKIPPED_CODE, reason: why }
    }
    if (verdict.status === "passed") return { id: d.id, level: d.level, status: "passed", code: 0, output: verdict.text }
    if (verdict.status === "failed") return { id: d.id, level: d.level, status: "failed", code: 1, reason: verdict.text }
    return { id: d.id, level: d.level, status: "skipped", code: SKIPPED_CODE, reason: verdict.text }
  })
}
