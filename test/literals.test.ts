// No new state-path literals. A1-T0 made packages/core/src/paths.ts the only place that names the project's state
// directory; this scan fails on any other file that spells either name out, so a consumer added from A1 on has to ask
// `stateDir`/`statePath` instead. Every entry in ALLOW is a consumer that predates the rule and that A5-T0/T5 replaces.
//
// The allowlist is path + literal pairs, not a bare literal list: the legacy detectors (A5-T2) may name the new state
// directory in their file, and nothing else may. A bare list would let a stale consumer hide behind a legacy
// detector's exception. A pair that no longer occurs fails as stale, and a pair that occurs without an entry fails naming
// file:line, so removing a consumer's literal forces removing its entry and a stale entry cannot shield a future hit.
//
// Comments count. The scan cannot tell prose from a path, and a comment is where the next literal gets copied from, so
// a file that only mentions the name in a comment still needs its entry.
//
// The scan's own file names no literal: it asks paths.ts for the names it forbids elsewhere, so a stray literal added
// here cannot hide behind an allowlist entry of its own.

import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { LEGACY_PROJECT_STATES, PROJECT_STATE } from "../packages/core/src/paths.ts"

const ROOT = join(import.meta.dirname, "..")

export const LITERALS = [PROJECT_STATE, ...LEGACY_PROJECT_STATES] as const

export type LiteralPair = readonly [file: string, literal: string]
export type ScannedFile = { readonly path: string; readonly text: string }
export type LiteralHit = { readonly file: string; readonly literal: string; readonly line: number; readonly count: number }
export type LiteralScan = { readonly stray: readonly LiteralHit[]; readonly stale: readonly LiteralPair[] }

// Shorthands so the allowlist names the directories through the one place that defines them: this file then spells no
// literal itself, and cannot shield a stray one behind an entry of its own.
const P = PROJECT_STATE
const L = LEGACY_PROJECT_STATES[0]
const O = LEGACY_PROJECT_STATES[1]

// Today's tree, generated from a scan: one entry per (file, literal) pair that names a state directory. Paths are
// project-relative. Remove an entry when its literal leaves the file; the stale check fails until you do.
export const ALLOW: ReadonlyArray<LiteralPair> = [
  // The one place the names are defined: the constants are these strings, and every other file asks this one.
  ["packages/core/src/paths.ts", P],
  ["packages/core/src/paths.ts", L],
  ["packages/core/src/paths.ts", O],
  // Property access that happens to contain an old name as a substring (the micromanager deps and session metadata);
  // the scan is a substring scan.
  ["packages/full/src/plugin.ts", L],
  ["packages/tui/src/switcher.ts", L],
  // Tests: fixtures and expectations that name a directory, most of them a project from before the move.
  ["test/decide.test.ts", L],
  ["test/decide.test.ts", O],
  ["test/helpers.test.ts", O],
  ["test/nogit.test.ts", L],
  ["test/permissions.test.ts", L],
  ["test/pick.test.ts", L],
  ["test/plan.test.ts", L],
  ["test/progress.test.ts", L],
  ["test/progress.test.ts", O],
  ["test/roles.test.ts", O],
  ["test/runner.test.ts", O],
  ["test/sandbox.test.ts", L],
  ["test/tools.test.ts", L],
  ["test/tools.test.ts", O],
  ["test/watchdog.test.ts", O],
]

const pairKey = (file: string, literal: string): string => `${file}\u0000${literal}`

// The first occurrence's line and the number of occurrences (non-overlapping; the literals cannot overlap).
// A literal as it is written in a string or in a regular expression: every "." and "/" may carry a backslash, so an
// escaped name in a regex literal counts as well as a plain one in a string (a regex in decide.ts once hid that way).
function pattern(literal: string): RegExp {
  return new RegExp(literal.split("").map((c) => (c === "." || c === "/" ? `\\\\?\\${c}` : c.replace(/[-[\]{}()*+?^$|\\]/g, "\\$&"))).join(""), "g")
}

function occurrences(text: string, literal: string): { line: number; count: number } {
  const hits = [...text.matchAll(pattern(literal))]
  if (hits.length === 0) return { line: 0, count: 0 }
  const first = hits[0]!.index!
  let line = 1
  for (let index = 0; index < first; index++) if (text.charCodeAt(index) === 10) line++
  return { line, count: hits.length }
}

// The checker, run over the real tree by the tests below and over a fixture by the self-test, so both outcomes are
// demonstrably reachable instead of merely claimed.
export function checkLiterals(files: ReadonlyArray<ScannedFile>, allow: ReadonlyArray<LiteralPair>): LiteralScan {
  const allowed = new Set(allow.map(([file, literal]) => pairKey(file, literal)))
  const present = new Set<string>()
  const stray: LiteralHit[] = []
  for (const file of files) {
    for (const literal of LITERALS) {
      const found = occurrences(file.text, literal)
      if (found.count === 0) continue
      const key = pairKey(file.path, literal)
      present.add(key)
      if (!allowed.has(key)) stray.push({ file: file.path, literal, line: found.line, count: found.count })
    }
  }
  return { stray, stale: allow.filter(([file, literal]) => !present.has(pairKey(file, literal))) }
}

const SKIP = new Set(["node_modules", "dist", "build"])

function walk(dir: string, files: ScannedFile[]): void {
  const entries = readdirSync(join(ROOT, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, files)
    // Generated .js is out of scope: tui.js is built from tui.tsx and would only duplicate its hits.
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push({ path, text: readFileSync(join(ROOT, path), "utf8") })
  }
}

export function scanTree(): ScannedFile[] {
  const files: ScannedFile[] = []
  walk("packages", files)
  walk("test", files)
  return files
}

const strayMessage = (stray: ReadonlyArray<LiteralHit>): string =>
  stray.length === 0
    ? ""
    : "state-path literals outside the allowlist:\n" +
      stray.map((hit) => `  ${hit.file}:${hit.line} names ${hit.literal} (${hit.count} occurrence${hit.count === 1 ? "" : "s"})`).join("\n") +
      "\nAsk stateDir/statePath in packages/core/src/paths.ts instead of spelling the directory name."

const staleMessage = (stale: ReadonlyArray<LiteralPair>): string =>
  stale.length === 0
    ? ""
    : "allowlist entries whose literal no longer occurs in that file:\n" +
      stale.map(([file, literal]) => `  ${file} lists ${literal}`).join("\n") +
      "\nRemove the entry; keeping it would shield a future literal in the same file."

test("the scan searches for real names, so a renamed constant cannot turn it into a search for nothing", () => {
  assert.ok(LITERALS.every((literal) => literal.length > 1))
  assert.equal(new Set(LITERALS).size, LITERALS.length)
  // Each name is found in today's tree: if a constant were renamed to something unused, the scan would pass over
  // every file and prove nothing. paths.ts itself must carry both.
  const files = scanTree()
  for (const literal of LITERALS) {
    assert.ok(files.some((file) => file.text.includes(literal)), `no occurrence of ${literal}: the constant no longer names the directory`)
  }
})

test("no state-path literal outside the allowlist", () => {
  const { stray } = checkLiterals(scanTree(), ALLOW)
  assert.deepEqual(stray, [], strayMessage(stray))
})

test("the allowlist has no stale entries", () => {
  const { stale } = checkLiterals(scanTree(), ALLOW)
  assert.deepEqual(stale, [], staleMessage(stale))
})

test("the allowlist has no duplicate pairs and names only files that exist", () => {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const [file, literal] of ALLOW) {
    const key = pairKey(file, literal)
    if (seen.has(key)) duplicates.push(`${file} lists ${literal} twice`)
    seen.add(key)
  }
  assert.deepEqual(duplicates, [], `duplicate allowlist entries:\n${duplicates.map((line) => `  ${line}`).join("\n")}`)
  const missing = [...new Set(ALLOW.map(([file]) => file).filter((file) => !existsSync(join(ROOT, file))))]
  assert.deepEqual(missing, [], `allowlist entries for files that do not exist:\n${missing.map((file) => `  ${file}`).join("\n")}`)
})

test("the checker reports a stray literal and a stale entry and accepts a listed hit", () => {
  const files: ScannedFile[] = [
    { path: "packages/listed.ts", text: `const dir = "${P}"\n` },
    { path: "packages/stray.ts", text: `const ok = 1\nconst dir = "${L}"\n` },
  ]
  const allow: ReadonlyArray<LiteralPair> = [
    ["packages/listed.ts", P], // accepted: the literal occurs and is listed
    ["packages/stray.ts", P], // stale: that file has the legacy name instead
  ]
  const { stray, stale } = checkLiterals(files, allow)
  assert.deepEqual(stray, [{ file: "packages/stray.ts", literal: L, line: 2, count: 1 }])
  assert.deepEqual(stale, [["packages/stray.ts", P]])
  assert.equal(stray.some((hit) => hit.file === "packages/listed.ts" && (hit.literal as string) === P), false, "a listed hit is accepted")
})
