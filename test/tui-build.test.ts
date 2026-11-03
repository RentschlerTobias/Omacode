import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = join(import.meta.dirname, "..")
const input = join(root, "packages", "tui", "src", "tui.tsx")
const built = join(root, "packages", "tui", "src", "tui.js")

// opencode's Solid transform skips paths containing node_modules (opencode#39986), so a package install
// loads exports["./tui"] raw. That entry has to be compiled JS: no JSX, no react jsx-runtime, only bare
// imports the host rewrites to its own runtime. This test keeps the committed file from going stale.
test("the committed TUI entry is the compiled src/tui.tsx, without JSX or react", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-tui-"))
  try {
    const out = join(dir, "tui.js")
    execFileSync(process.execPath, [join(root, "scripts", "build-tui.mjs"), input, out], { cwd: root })
    assert.equal(
      readFileSync(built, "utf8"),
      readFileSync(out, "utf8"),
      "packages/tui/src/tui.js is stale: run `npm run build:tui` and commit it",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const code = readFileSync(built, "utf8")
  assert.ok(!/from\s+["']react/.test(code), "the TUI entry must not import react")
  assert.ok(!/<[A-Za-z][^>]*>/.test(code), "the TUI entry must not contain JSX")
  assert.match(code, /from "@opentui\/solid"/)
})

test("the package exports ./tui as that compiled file and ships it", () => {
  const pkg = JSON.parse(readFileSync(join(root, "packages", "tui", "package.json"), "utf8"))
  assert.equal(pkg.exports["./tui"], "./src/tui.js")
  assert.ok(pkg.files.includes("src"), "files must ship src/tui.js")
})
