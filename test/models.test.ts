// The model registry (B5-T4, D18). What these tests fix is the policy, not a table's contents: a hash that is known and
// permitted proceeds, a hash on the blocklist is refused by name and reason, and a hash nobody recorded is refused with
// the offer to register it. The table's own entries are checked for the property that makes them worth having — each one
// either lists a hash or says in words that it cannot be verified here — because a registry that quietly claims a
// licence nobody read is the failure D18 exists to prevent.
//
// The registration tests write into a temporary state directory, never the user's: `registerModel` takes the directory a
// file belongs in, and the default (the per-user state directory) is only what a real run uses.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

import {
  BLOCKED_MODELS,
  MODEL_ENTRIES,
  MODEL_REGISTRY,
  assertModelRegistry,
  modelsPath,
  nameKey,
  readModelRegistry,
  registerModel,
  registryWith,
  resolveModel,
  type ModelEntry,
  type ModelRegistry,
} from "../packages/artifact/src/models.ts"

const stateDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "mm-models-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  name: "A test checkpoint",
  spdx: "Apache-2.0",
  territories: ["world"],
  use: "tests",
  hashes: [digest("a test checkpoint")],
  verified: "listed in this test",
  ...over,
})

const registryOf = (models: readonly ModelEntry[], blocked: ModelRegistry["blocked"] = []): ModelRegistry => ({
  models,
  blocked,
})

// ---------------------------------------------------------------------------------------------------------------------
// The table.

test("the table names the six checkpoints B5-T4 asks for, and every entry is verifiable or says it cannot be", () => {
  assert.doesNotThrow(() => assertModelRegistry(MODEL_REGISTRY))

  const names = MODEL_ENTRIES.map((model) => nameKey(model.name))
  for (const wanted of ["wan22", "mochi", "cogvideox", "flux1schnell", "qwenimage", "sdxl"]) {
    assert.ok(
      names.some((name) => name.includes(wanted)),
      `the registry must know ${wanted}: ${MODEL_ENTRIES.map((model) => model.name).join(", ")}`,
    )
  }

  // The rule the roadmap states: a hash is listed, or the entry says it cannot be verified here. Every entry in this
  // table happens to list one, which is why the "cannot" branch is tested separately below.
  for (const model of MODEL_ENTRIES) {
    assert.ok(model.hashes.length > 0, `${model.name} lists no hash and does not say it cannot be verified`)
    assert.ok(model.verified.trim().length > 0, `${model.name} does not say how it was verified`)
    for (const hash of model.hashes) assert.match(hash, /^[0-9a-f]{64}$/)
    assert.ok(model.territories.length > 0)
    assert.ok(model.use.trim().length > 0, `${model.name} does not say what its licence permits`)
  }
})

test("an entry with neither a hash nor the words 'cannot be verified here' is refused", () => {
  const naked = entry({ hashes: [], verified: "it is probably Apache-2.0" })
  assert.throws(() => assertModelRegistry(registryOf([naked])), /cannot be verified here/)

  const honest = entry({ hashes: [], verified: "cannot be verified here: no weights and no model card on this machine" })
  assert.doesNotThrow(() => assertModelRegistry(registryOf([honest])))

  // The other consistency rules: a duplicate name, a hash claimed twice, a missing licence, an unknown territory.
  assert.throws(() => assertModelRegistry(registryOf([entry(), entry({ hashes: [digest("another")] })])), /listed twice/)
  assert.throws(
    () => assertModelRegistry(registryOf([entry(), entry({ name: "Another" })])),
    /claimed by both/,
  )
  assert.throws(() => assertModelRegistry(registryOf([entry({ spdx: "" })])), /no licence/)
  assert.throws(
    () => assertModelRegistry(registryOf([entry({ territories: ["Mars" as never] })])),
    /unknown territory/,
  )
})

test("CogVideoX is per-variant: the 2B weights are Apache-2.0 and the 5B weights are not", () => {
  const two = MODEL_ENTRIES.find((model) => model.name === "CogVideoX-2B")
  const five = MODEL_ENTRIES.find((model) => model.name === "CogVideoX-5B")
  assert.ok(two && five)

  assert.equal(two.spdx, "Apache-2.0")
  assert.notEqual(five.spdx, "Apache-2.0")
  assert.match(five.spdx, /^LicenseRef-/)
  assert.match(five.verified, /NOT Apache-2\.0/)
  assert.match(five.use, /commercial/)
  assert.ok(two.hashes.length > 0 && five.hashes.length > 0)
})

test("the blocklist names the two models D3 excludes, with a reason each", () => {
  const names = BLOCKED_MODELS.map((model) => nameKey(model.name))
  assert.ok(names.includes("minimaxh3"))
  assert.ok(names.includes("hunyuanvideo"))
  for (const blocked of BLOCKED_MODELS) {
    assert.ok(blocked.reason.length > 0)
    // No hash is recorded here, and the empty list is safe because an unknown hash is refused anyway. If one is added
    // later the registry assertion keeps it from colliding with an allowed entry.
    for (const hash of blocked.hashes) assert.match(hash, /^[0-9a-f]{64}$/)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Resolution.

test("a known, permitted hash proceeds, and the verdict carries the licence, territory and use", () => {
  const parse = MODEL_ENTRIES.find((model) => model.name === "SDXL base 1.0")
  assert.ok(parse)
  const verdict = resolveModel({ declared: "SDXL base", hash: parse.hashes[0] })

  assert.equal(verdict.status, "allowed")
  if (verdict.status !== "allowed") return
  assert.equal(verdict.name, "SDXL base 1.0")
  assert.equal(verdict.spdx, "LicenseRef-CreativeML-OpenRAIL++-M")
  assert.equal(verdict.territory, "EU", "the default territory is the EU")
  assert.match(verdict.reason, /permits use in EU/)
  assert.match(verdict.use, /commercial/i)
})

test("a blocklisted hash is refused by name and by the reason the blocklist records", () => {
  const hash = digest("a model whose licence excludes the EU")
  const registry = registryOf([], [{ name: "An excluded model", reason: "its licence excludes the EU (D3)", hashes: [hash] }])

  const verdict = resolveModel({ declared: "SDXL base", hash }, registry)
  assert.equal(verdict.status, "blocked")
  if (verdict.status !== "blocked") return
  assert.equal(verdict.name, "An excluded model")
  assert.match(verdict.reason, /is blocked as "An excluded model"/)
  assert.match(verdict.reason, /its licence excludes the EU \(D3\)/)
  assert.match(verdict.reason, /refused and not loaded/)
})

test("a blocked model is refused by name too, because the blocklist records no hash for D3's two models", () => {
  for (const declared of ["HunyuanVideo", "Hunyuan Video", "MiniMax H3"]) {
    const verdict = resolveModel({ declared, hash: digest("unknown weights") })
    assert.equal(verdict.status, "blocked", declared)
    if (verdict.status === "blocked") assert.match(verdict.reason, /blocked as/)
  }
})

test("an unknown hash is refused with the offer to register it, and never allowed on its name", () => {
  const hash = "f".repeat(64)
  const verdict = resolveModel({ declared: "SDXL base", hash })

  assert.equal(verdict.status, "unknown")
  if (verdict.status !== "unknown") return
  assert.match(verdict.reason, /is not in the model registry/)
  assert.match(verdict.reason, /a name proves nothing, because a workflow can load any checkpoint on disk/)
  assert.match(verdict.reason, /registerModel\(\{ hash, name, license, territory \}\)/)
  assert.deepEqual(verdict.offer, { hash, name: "SDXL base", license: "", territory: "EU" })
})

test("a checkpoint with no hash at all is the unknown case, not an exception to it", () => {
  const verdict = resolveModel({ declared: "SDXL base" })
  assert.equal(verdict.status, "unknown")
  if (verdict.status === "unknown") {
    assert.match(verdict.reason, /has no sha256 to resolve/)
    assert.match(verdict.reason, /registerModel/)
    assert.equal(verdict.offer.hash, undefined)
  }
})

test("a licence that permits no EU use is refused, and the sentence names the territory and the licence", () => {
  const hash = digest("a model whose licence is US-only")
  const registry = registryOf([entry({ name: "US only", territories: ["US"], hashes: [hash] })])

  const verdict = resolveModel({ hash }, registry)
  assert.equal(verdict.status, "territory")
  if (verdict.status !== "territory") return
  assert.match(verdict.reason, /may not be used in EU/)
  assert.match(verdict.reason, /Apache-2\.0/)
  assert.match(verdict.reason, /permits US/)

  // The same hash for the territory the licence names is allowed, so the refusal is about the territory and not the hash.
  assert.equal(resolveModel({ hash, territory: "US" }, registry).status, "allowed")
})

test("an unknown territory is a mistake in code, not data, and is refused rather than defaulted", () => {
  assert.throws(() => resolveModel({ hash: digest("x"), territory: "Mars" as never }), /unknown territory/)
})

// ---------------------------------------------------------------------------------------------------------------------
// Registration.

test("registerModel writes the file under the state directory and the registered hash then proceeds", (t) => {
  const dir = stateDir(t)
  const hash = digest("the checkpoint on this machine")
  const { path, entry: written } = registerModel(
    { hash, name: "A checkpoint I installed", license: "Apache-2.0", territory: "EU", use: "local image generation" },
    { dir },
  )

  assert.equal(path, modelsPath(dir))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(written.hashes[0], hash)
  assert.match(written.verified, /registered by the user/)

  const before = resolveModel({ hash })
  assert.equal(before.status, "unknown", "the code table did not learn anything from the write")

  const read = readModelRegistry({ dir })
  assert.deepEqual(read.errors, [])
  assert.equal(read.entries.length, 1)
  assert.equal(read.entries[0]?.spdx, "Apache-2.0")

  const after = resolveModel({ hash, declared: "A checkpoint I installed" }, registryWith(read.entries))
  assert.equal(after.status, "allowed")
  if (after.status === "allowed") {
    assert.equal(after.name, "A checkpoint I installed")
    assert.equal(after.territory, "EU")
  }

  // A second, different hash does not inherit the first registration.
  assert.equal(resolveModel({ hash: digest("another file") }, registryWith(read.entries)).status, "unknown")
})

test("the registry file round-trips, and a hand-edited entry without a licence is refused", (t) => {
  const dir = stateDir(t)
  registerModel({ hash: digest("one"), name: "One", license: "Apache-2.0", territory: ["EU", "UK"] }, { dir })
  registerModel({ hash: digest("two"), name: "Two", license: "LicenseRef-Test", territory: "world" }, { dir })

  const read = readModelRegistry({ dir })
  assert.deepEqual(read.errors, [])
  assert.deepEqual(
    read.entries.map((model) => [model.name, model.spdx, model.territories, model.hashes.length]),
    [
      ["Two", "LicenseRef-Test", ["world"], 1],
      ["One", "Apache-2.0", ["EU", "UK"], 1],
    ],
  )

  // Hand-edited: the licence line is gone. Nothing is allowed from the file, and the error addresses the field.
  const path = modelsPath(dir)
  const file = JSON.parse(readFileSync(path, "utf8")) as { models: Record<string, unknown>[] }
  delete file.models[0]!["spdx"]
  writeFileSync(path, JSON.stringify(file))

  const broken = readModelRegistry({ dir })
  assert.deepEqual(broken.entries, [])
  assert.equal(broken.errors.length, 1)
  assert.match(broken.errors[0] ?? "", /models\[0\]\.spdx: expected a non-empty licence identifier/)

  // A file from a version this code does not know is refused by number, like a spec is.
  writeFileSync(path, JSON.stringify({ version: 2, models: [] }))
  assert.match(readModelRegistry({ dir }).errors[0] ?? "", /version 2, expected 1/)
})

test("registerModel refuses a blocked model, a bad hash, a missing licence and an unknown territory", (t) => {
  const dir = stateDir(t)
  const hash = digest("whatever")

  assert.throws(
    () => registerModel({ hash, name: "HunyuanVideo", license: "Apache-2.0", territory: "EU" }, { dir }),
    /is blocked as "HunyuanVideo"/,
  )
  assert.throws(() => registerModel({ hash: "abc", name: "X", license: "Apache-2.0", territory: "EU" }, { dir }), /expected a lowercase sha256/)
  assert.throws(() => registerModel({ hash, name: "X", license: "", territory: "EU" }, { dir }), /license: expected/)
  assert.throws(() => registerModel({ hash, name: "", license: "Apache-2.0", territory: "EU" }, { dir }), /name: expected/)
  assert.throws(
    () => registerModel({ hash, name: "X", license: "Apache-2.0", territory: "Mars" as never }, { dir }),
    /territory: expected one of/,
  )
  // Nothing above wrote a file, so the state directory is still empty of one.
  assert.equal(readModelRegistry({ dir }).entries.length, 0)
})

test("a broken registry file is not overwritten: the user's edit is not silently replaced", (t) => {
  const dir = stateDir(t)
  const path = modelsPath(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, "{ this is not JSON")
  assert.throws(
    () => registerModel({ hash: digest("x"), name: "X", license: "Apache-2.0", territory: "EU" }, { dir }),
    /nothing is written, because the registry file cannot be read/,
  )
  assert.equal(readFileSync(path, "utf8"), "{ this is not JSON")
})

test("a registered entry is consulted before the code table, so the user's own record wins", (t) => {
  const dir = stateDir(t)
  const parse = MODEL_ENTRIES.find((model) => model.name === "FLUX.1 schnell")
  assert.ok(parse)
  const hash = parse.hashes[0]!
  registerModel({ hash, name: "FLUX.1 schnell (my copy)", license: "Apache-2.0", territory: "US" }, { dir })

  const read = readModelRegistry({ dir })
  const registry = registryWith(read.entries)
  assert.equal(resolveModel({ hash }, registry).status, "territory", "the user's own territory is the one checked")
  assert.equal(resolveModel({ hash, territory: "US" }, registry).status, "allowed")
  // The code table still answers for the same hash when no registration is loaded.
  assert.equal(resolveModel({ hash }).status, "allowed")
})
