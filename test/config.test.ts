import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { loadSettings, parseAutoMerge } from "../src/config.ts"

const config = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "mm-config-")), "micromanager.jsonc")
  writeFileSync(path, text)
  return path
}

test("autoMerge is true when missing, holds its value, and a wrong one falls back to the default with an error", () => {
  assert.equal(parseAutoMerge("{}"), true)
  assert.equal(parseAutoMerge('{"autoMerge": true}'), true)
  assert.equal(parseAutoMerge('{"autoMerge": false}'), false)
  assert.throws(() => parseAutoMerge('{"autoMerge": "yes"}'), /autoMerge must be true or false/)

  assert.equal(loadSettings(config("{}")).autoMerge, true)
  assert.equal(loadSettings(config('{"autoMerge": true}')).autoMerge, true)
  assert.equal(loadSettings(config('{"autoMerge": false}')).autoMerge, false)
  const bad = loadSettings(config('{"autoMerge": "yes"}'))
  assert.equal(bad.autoMerge, true) // the default, and said so
  assert.match(bad.error ?? "", /autoMerge must be true or false/)
})
