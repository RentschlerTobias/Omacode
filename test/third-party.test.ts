// A6-T9, the licence manifest: the committed manifest matches what components.json and package-lock.json say, every
// component carries the fields a reader needs, and every creative tool install.sh offers is listed at the version it
// is pinned to, so a pin cannot move without its licence row.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { build, markdown, npmPackages } from "../scripts/third-party.mjs"
import { PINS, TOOL_INFO, TOOL_NAMES } from "../packages/micromanager/src/creative-tools.ts"

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
const components = json("../licenses/components.json")
const lock = json("../package-lock.json")
const committed = json("../licenses/third-party.json")

test("the committed manifest and THIRD_PARTY.md are what the generator makes from components.json and the lockfile", () => {
  const fresh = build({ components, lock, python: committed.python })
  assert.deepEqual(committed.components, fresh.components, "run node scripts/third-party.mjs")
  assert.deepEqual(committed.npm, fresh.npm, "run node scripts/third-party.mjs")
  assert.equal(readFileSync(new URL("../THIRD_PARTY.md", import.meta.url), "utf8"), markdown(committed))
})

test("every component names its licence, where it may be used, what you may do with its output and who installs it", () => {
  const installers = new Set(["minimal", "coding", "creator", "full", "downloaded", "you", "planned"])
  for (const c of components.components) {
    for (const field of ["name", "kind", "spdx", "installedBy", "source", "territory", "commercialOutput", "attribution"]) {
      assert.ok(typeof c[field] === "string" && c[field].trim(), `${c.name}: ${field}`)
    }
    assert.ok(installers.has(c.installedBy), `${c.name}: installedBy ${c.installedBy}`)
  }
  for (const p of npmPackages(lock)) assert.notEqual(p.spdx, "UNKNOWN", p.name)
})

test("every creative tool install.sh offers is in the manifest at its pinned version", () => {
  const pin: Record<string, string> = { hyperframes: PINS.hyperframes, manim: PINS.manim, comfyui: PINS.comfyui, "comfy-mcp": PINS.comfyMcp }
  for (const tool of TOOL_NAMES) {
    const title = TOOL_INFO[tool].title
    const row = components.components.find((c: { name: string }) => c.name.toLowerCase().startsWith(title.toLowerCase()))
    assert.ok(row, `${title} has a licence row`)
    assert.equal(row.version, pin[tool], `${title}: the manifest's version is the pin`)
  }
  assert.equal(components.components.find((c: { name: string }) => c.name === "comfy-cli")?.version, PINS.comfyCli)
})
