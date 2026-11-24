// The published packages carry JavaScript (scripts/pack-js.mjs): Node runs no TypeScript under node_modules, so an
// installed CLI and services unit would not start from .ts. prepack emits dist/ and points package.json at it;
// postpack puts everything back.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = new URL("..", import.meta.url).pathname
const script = join(root, "scripts", "pack-js.mjs")

test("prepack emits dist/ with .js imports and points exports at it; postpack restores the package", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-js-"))
  try {
    const pkg = join(dir, "core")
    cpSync(join(root, "packages", "core"), pkg, { recursive: true })
    const before = readFileSync(join(pkg, "package.json"), "utf8")

    execFileSync(process.execPath, [script], { cwd: pkg, stdio: "pipe" })
    const packed = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))
    assert.equal(packed.exports["./paths"], "./dist/paths.js")
    assert.equal(packed.exports["./main"], "./dist/main.js")
    assert.ok(packed.files.includes("dist") && !packed.files.includes("src"))
    const paths = readFileSync(join(pkg, "dist", "paths.js"), "utf8")
    assert.equal(/from\s+["']\.\.?\/[^"']+\.ts["']/.test(paths), false, "no relative .ts import is left")
    assert.equal(/:\s*string\b/.test(paths), false, "types are gone")
    assert.ok(existsSync(join(pkg, "LICENSE")))

    execFileSync(process.execPath, [script, "--restore"], { cwd: pkg, stdio: "pipe" })
    assert.equal(readFileSync(join(pkg, "package.json"), "utf8"), before)
    assert.equal(existsSync(join(pkg, "dist")), false)
    assert.equal(existsSync(join(pkg, "LICENSE")), false)
    assert.equal(existsSync(join(pkg, "package.json.pack-backup")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the micromanager package carries the decider's sources without models or training data, and a bin", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-js-"))
  try {
    const pkg = join(dir, "micromanager")
    cpSync(join(root, "packages", "micromanager"), pkg, { recursive: true, filter: (f) => !f.includes("node_modules") })
    execFileSync(process.execPath, [script], { cwd: pkg, stdio: "pipe" })
    const packed = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))
    assert.equal(packed.bin.omacode, "./dist/cli.js")
    assert.ok(readFileSync(join(pkg, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node"))
    assert.ok(existsSync(join(pkg, "decider", "uv.lock")) && existsSync(join(pkg, "decider", "decider", "server.py")))
    for (const left of ["models", "data", "train", ".venv", "decider.service"]) assert.equal(existsSync(join(pkg, "decider", left)), false, left)
    assert.ok(existsSync(join(pkg, "THIRD_PARTY.md")))
    assert.ok(existsSync(join(pkg, "dist", "services-main.js")))
    execFileSync(process.execPath, [script, "--restore"], { cwd: pkg, stdio: "pipe" })
    assert.equal(existsSync(join(pkg, "decider")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
