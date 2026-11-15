// Provenance (B1-T3): the small file that travels with a produced artifact and answers, later and without the process
// that made it, which tool made this, at what version, under which licence and territory, with which model and seed,
// from which inputs. A deck, a video, a site or an image set leaves the machine and is used again by someone who cannot
// ask the adapter. This file is what they can read instead.
//
// The model is named, but the name proves nothing: the same disk path can hold a different checkpoint tomorrow, and two
// machines can disagree about what "sdxl" is. So the hash of the model *file* is the fact, and the name is only a label
// beside it. `ModelProvenance.verified` records whether that hash was computed from the file on this machine or merely
// declared by an adapter that drives a remote model. The distinction is kept instead of hidden because the two hashes
// are not equally strong: one is about bytes this machine read, the other is the adapter's word. B5-T4 will enforce
// licences by hash and must be able to tell which hash it can trust.
//
// The asset manifest is the companion: every output file with its byte count and hash. A file that changed after the
// job finished is then noticed by the next reader, not by the person who discovers the slide is blank.
//
// A licence or a territory is never guessed. Empty ones are refused here (D18): an artifact that cannot say what its
// model may be used for is not better off with a default.
//
// Nothing here reads the clock. The caller passes `createdAt`, so a test fixes the time and a provenance written twice
// from the same job is the same bytes. The only writer is `writeProvenance`, and it validates before it writes.

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { insidePath } from "./paths.ts"
import { ARTIFACT_KINDS, canonicalJson, type ArtifactKind } from "./spec.ts"

export interface ToolProvenance {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly territory: string
}

export interface ModelProvenance {
  readonly name: string
  readonly version?: string
  // Where the file was when the hash was taken. It travels for the reader's sake, but the hash above is what identifies
  // the model: this path may hold a different file by the time someone reads it.
  readonly file?: string
  readonly sha256: string
  // True only when the hash was computed from `file`; false when it was declared with no file to check it against.
  readonly verified: boolean
  readonly license: string
  readonly territory: string
}

export interface InputHash {
  readonly path: string
  readonly sha256: string
}

export interface Provenance {
  readonly tool: ToolProvenance
  readonly model?: ModelProvenance
  readonly seed?: number
  readonly inputs: readonly InputHash[]
  readonly spec: { readonly kind: ArtifactKind; readonly version: number; readonly sha256: string }
  readonly createdAt: string
}

// Where an output file came from. "placeholder" is its own source because a missing asset slot that was rendered as a
// labelled placeholder (B3-T6) is not an input and not a tool output in the same sense: a reader looking for the real
// image should see why it is not there.
export interface ManifestEntry {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly source: "tool" | "model" | "input" | "placeholder"
}

export interface AssetManifest {
  readonly assets: readonly ManifestEntry[]
}

type Errors = string[]

const SHA256 = /^[0-9a-f]{64}$/
// An ISO 8601 timestamp with a zone. `Date.parse` alone would also accept "January 2, 2026", which is a date but not the
// form this file records, and a reader should not have to guess which of two shapes it is looking at.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const got = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)
const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const errorCode = (error: unknown): string | undefined => (isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined)

const topic = (path: string): string => (path ? `${path}: ` : "")
const child = (path: string, key: string): string => (path ? `${path}.${key}` : key)
const at = (path: string, index: number): string => `${path}[${index}]`

// A hash of a file, streamed. A model checkpoint is gigabytes; reading it into memory to hash it would turn recording a
// fact into an out-of-memory failure on exactly the machines that have a model worth recording.
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return hash.digest("hex")
}

// Record a model, or the reasons it cannot be recorded. An adapter supplies the facts; this file decides whether they
// are enough. A file always wins over a declared hash: the bytes are what the job actually loaded. A declaration that
// disagrees with those bytes is an error, not a warning, because one of the two is wrong and a warning would let the
// wrong one travel.
export async function modelProvenance(input: {
  name: string
  file?: string
  sha256?: string
  version?: string
  license: string
  territory: string
}): Promise<{ model?: ModelProvenance; errors: readonly string[] }> {
  const errors: Errors = []

  // A model with no name and no hash is not a model, it is an empty field. Which of the two is missing decides what the
  // message can point at, so the message names the field rather than "the model".
  if (!input.name) errors.push("name: expected a non-empty string")
  if (!input.name && !input.sha256) errors.push("model: a model needs a name or a declared sha256, not neither")
  if (input.version !== undefined && !input.version) errors.push("version: expected a non-empty string")
  if (!input.license) errors.push("license: expected a non-empty string")
  if (!input.territory) errors.push("territory: expected a non-empty string")
  if (input.file !== undefined && !input.file) errors.push("file: expected a non-empty path")
  if (input.sha256 !== undefined && !SHA256.test(input.sha256)) {
    errors.push(`sha256: expected 64 lowercase hex characters, got ${shown(input.sha256)}`)
  }
  // No file means the only identity is the declared hash. Without one there is nothing to record.
  if (input.file === undefined && input.sha256 === undefined) errors.push("sha256: required when there is no file to hash")

  // A bad licence does not need a gigabyte read to be refused; checking the cheap facts first also means a model file is
  // only opened once the record it would belong to is otherwise valid.
  if (errors.length) return { errors }

  let sha256 = input.sha256
  let verified = false

  if (input.file !== undefined) {
    let computed: string
    try {
      computed = await sha256File(input.file)
    } catch (error) {
      return { errors: [`file: cannot hash ${input.file} (${reason(error)})`] }
    }
    if (sha256 !== undefined && sha256 !== computed) {
      return { errors: [`sha256: declared ${sha256}, but ${input.file} hashes to ${computed}`] }
    }
    // The hash came from the bytes, so it supersedes whatever was declared.
    sha256 = computed
    verified = true
  }

  return {
    model: {
      name: input.name,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.file !== undefined ? { file: input.file } : {}),
      sha256: sha256!,
      verified,
      license: input.license,
      territory: input.territory,
    },
    errors,
  }
}

// The hash a spec hashes to: canonical JSON first, so the order the author wrote the keys in cannot change it, while a
// changed slide title does. This is the value `Provenance.spec.sha256` carries, so a reader can tell whether the spec
// beside an artifact is the one that produced it.
export function specHash(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec), "utf8").digest("hex")
}

export interface ProvenanceParse {
  readonly provenance?: Provenance
  readonly errors: readonly string[]
}

const TOOL_KEYS = ["name", "version", "license", "territory"] as const
const MODEL_KEYS = ["name", "version", "file", "sha256", "verified", "license", "territory"] as const
const INPUT_KEYS = ["path", "sha256"] as const
const SPEC_KEYS = ["kind", "version", "sha256"] as const
const PROVENANCE_KEYS = ["tool", "model", "seed", "inputs", "spec", "createdAt"] as const

// A record with exactly these keys, refusing a stranger at its own address. The strictness has the same reason as in
// spec.ts: the spec hash and the checks address fields by path, so a key that was silently dropped would let two
// different records read the same.
function record(
  value: unknown,
  path: string,
  keys: readonly string[],
  errors: Errors,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push(`${topic(path)}expected an object, got ${got(value)}`)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(`${child(path, key)}: unknown key`)
  }
  return value
}

function text(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: Errors,
  options: { readonly required?: boolean; readonly nonEmpty?: boolean } = {},
): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    if (options.required !== false) errors.push(`${p}: required`)
    return
  }
  if (typeof value !== "string") {
    errors.push(`${p}: expected a string, got ${got(value)}`)
    return
  }
  if (options.nonEmpty && !value) errors.push(`${p}: expected a non-empty string`)
}

function numberField(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: Errors,
  expectation: string,
  ok: (value: number) => boolean,
  required = true,
): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    if (required) errors.push(`${p}: required`)
    return
  }
  if (typeof value !== "number") {
    errors.push(`${p}: expected ${expectation}, got ${got(value)}`)
    return
  }
  if (!Number.isFinite(value)) {
    errors.push(`${p}: expected ${expectation}, got ${String(value)}`)
    return
  }
  if (!ok(value)) errors.push(`${p}: expected ${expectation}, got ${value}`)
}

function hashField(obj: Record<string, unknown>, key: string, path: string, errors: Errors, required: boolean): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    if (required) errors.push(`${p}: required`)
    return
  }
  if (typeof value !== "string") {
    errors.push(`${p}: expected 64 lowercase hex characters, got ${got(value)}`)
    return
  }
  if (!SHA256.test(value)) errors.push(`${p}: expected 64 lowercase hex characters, got ${shown(value)}`)
}

// The lexical rule from spec.ts, repeated because that file keeps its helpers private and a manifest entry is a job
// path like a page path. The host runner (B1-T5) is still what decides whether the bytes stay inside the real job; this
// only refuses a path that could never be inside one.
function pathProblem(value: string): string | undefined {
  if (!value) return "a path must not be empty"
  if (value.startsWith("/")) return "a path must be relative to the job directory"
  if (value.includes("\\")) return 'a path must use "/" as its separator'
  const segments = value.split("/")
  if (segments.includes(".") || segments.includes("..")) return 'a path must not contain "." or ".." segments'
  if (segments.includes("")) return "a path must not contain an empty segment"
  return undefined
}

function pathField(obj: Record<string, unknown>, key: string, path: string, errors: Errors, required: boolean): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    if (required) errors.push(`${p}: required`)
    return
  }
  if (typeof value !== "string") {
    errors.push(`${p}: expected a string, got ${got(value)}`)
    return
  }
  const problem = pathProblem(value)
  if (problem) errors.push(`${p}: ${problem}, got ${shown(value)}`)
}

function objField(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: Errors,
  keys: readonly string[],
  each: (value: Record<string, unknown>, path: string) => void,
): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    errors.push(`${p}: required`)
    return
  }
  const nested = record(value, p, keys, errors)
  if (nested) each(nested, p)
}

function optObjField(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: Errors,
  keys: readonly string[],
  each: (value: Record<string, unknown>, path: string) => void,
): void {
  const value = obj[key]
  if (value === undefined) return
  const p = child(path, key)
  const nested = record(value, p, keys, errors)
  if (nested) each(nested, p)
}

function toolField(value: Record<string, unknown>, path: string, errors: Errors): void {
  for (const key of TOOL_KEYS) text(value, key, path, errors, { nonEmpty: true })
}

function modelField(value: Record<string, unknown>, path: string, errors: Errors): void {
  text(value, "name", path, errors, { nonEmpty: true })
  text(value, "version", path, errors, { required: false, nonEmpty: true })
  text(value, "file", path, errors, { required: false, nonEmpty: true })
  text(value, "license", path, errors, { nonEmpty: true })
  text(value, "territory", path, errors, { nonEmpty: true })
  hashField(value, "sha256", path, errors, true)

  const verified = value["verified"]
  if (verified === undefined) errors.push(`${child(path, "verified")}: required`)
  else if (typeof verified !== "boolean") errors.push(`${child(path, "verified")}: expected a boolean, got ${got(verified)}`)
  // A hash is "verified" because a file was read. Saying so with no file is not a weaker claim, it is a contradiction:
  // there is nothing that could have been checked.
  else if (verified && (value["file"] === undefined || value["file"] === "")) {
    errors.push(
      `${child(path, "verified")}: true needs ${child(path, "file")}, because a hash not computed from a file cannot be checked`,
    )
  }
}

function inputField(value: unknown, path: string, errors: Errors): void {
  const entry = record(value, path, INPUT_KEYS, errors)
  if (!entry) return
  pathField(entry, "path", path, errors, true)
  hashField(entry, "sha256", path, errors, true)
}

// Read provenance strictly, like `parseSpec`: path-addressed errors and no unknown keys. The record is what a later
// reader relies on (the quality gate B1-T7, the licence-by-hash rule B5-T4), so a half-understood record is refused
// rather than handed on with a field missing.
export function parseProvenance(value: unknown): ProvenanceParse {
  const errors: Errors = []
  const obj = record(value, "", PROVENANCE_KEYS, errors)
  if (!obj) return { errors }

  objField(obj, "tool", "", errors, TOOL_KEYS, (value, p) => toolField(value, p, errors))
  optObjField(obj, "model", "", errors, MODEL_KEYS, (value, p) => modelField(value, p, errors))
  numberField(obj, "seed", "", errors, "an integer", (n) => Number.isInteger(n), false)

  const inputs = obj["inputs"]
  if (inputs === undefined) errors.push("inputs: required")
  else if (!Array.isArray(inputs)) errors.push(`inputs: expected an array, got ${got(inputs)}`)
  // An artifact made from a brief alone has no input file, so an empty list is honest. An entry without a path or a
  // hash is not: it says "there was an input" without saying which.
  else inputs.forEach((item, index) => inputField(item, at("inputs", index), errors))

  objField(obj, "spec", "", errors, SPEC_KEYS, (spec, p) => {
    const kind = spec["kind"]
    if (kind === undefined) errors.push(`${child(p, "kind")}: required`)
    else if (typeof kind !== "string") errors.push(`${child(p, "kind")}: expected a string, got ${got(kind)}`)
    else if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${child(p, "kind")}: unknown artifact kind ${shown(kind)}`)
    }
    // The version is recorded, not interpreted: a provenance for a spec version this file does not know is still a
    // true record of what ran. Only its shape is checked here.
    numberField(spec, "version", p, errors, "a positive integer", (n) => Number.isInteger(n) && n > 0)
    hashField(spec, "sha256", p, errors, true)
  })

  const createdAt = obj["createdAt"]
  if (createdAt === undefined) errors.push("createdAt: required")
  else if (typeof createdAt !== "string") errors.push(`createdAt: expected a string, got ${got(createdAt)}`)
  else if (!ISO.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    errors.push(`createdAt: expected an ISO 8601 timestamp with a zone, got ${shown(createdAt)}`)
  }

  return errors.length ? { errors } : { provenance: obj as unknown as Provenance, errors }
}

// Build the record a caller passes around, refusing a broken one at the moment it is built rather than when it reaches a
// file. The check is the parser above, so there is one description of a valid provenance, not two.
export function assertProvenance(value: unknown): void {
  const { errors } = parseProvenance(value)
  if (errors.length) throw new Error(`invalid provenance: ${errors.join("; ")}`)
}

export function buildProvenance(input: {
  tool: ToolProvenance
  model?: ModelProvenance
  seed?: number
  inputs: readonly InputHash[]
  spec: { kind: ArtifactKind; version: number; sha256: string }
  createdAt: string
}): Provenance {
  // The caller passes the clock; nothing here reads it, so the same job can be recorded twice with the same bytes.
  assertProvenance(input)
  return input
}

// The one file this module writes, named once. `join` rather than a literal directory, because the job directory is the
// caller's and may be anywhere.
export function provenancePath(jobDir: string): string {
  return join(jobDir, "provenance.json")
}

// Write the record beside the job. The directory is 0700 and the file 0600: provenance can name a model, an input and a
// licence, which is the user's business and not another account's. `chmod` after the write because `writeFile` applies
// its mode only when it creates the file — a record from an earlier run would otherwise keep its old permissions.
export async function writeProvenance(jobDir: string, provenance: Provenance): Promise<string> {
  assertProvenance(provenance)
  await mkdir(jobDir, { recursive: true, mode: 0o700 })
  const path = provenancePath(jobDir)
  await writeFile(path, `${canonicalJson(provenance)}\n`, { encoding: "utf8", mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

// Read a job's record back. A missing file is its own answer, not an exception: "no provenance.json yet" is what the
// caller needs to know before it can decide whether that is a problem.
export async function readProvenance(jobDir: string): Promise<ProvenanceParse> {
  const path = provenancePath(jobDir)
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { errors: ["no provenance.json yet"] }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    return { errors: [`provenance.json: not valid JSON (${reason(error)})`] }
  }
  return parseProvenance(value)
}

// Whether `target` is `root` or below it is one rule for the whole package: `insidePath` in paths.ts resolves both and
// compares path segments, so "/job-1" does not accept "/job-10/out.png" and a symlink that leaves the job is outside.
async function resolveInside(root: string, path: string): Promise<string> {
  const problem = pathProblem(path)
  if (problem) throw new Error(`${path}: ${problem}`)
  let real: string
  try {
    real = await realpath(join(root, path))
  } catch (error) {
    throw new Error(`${path}: cannot resolve (${reason(error)})`)
  }
  // A symlink inside the job pointing out of it is the case a lexical check cannot see: the name is harmless and the
  // bytes are not. The real path decides.
  if (!insidePath(root, real)) throw new Error(`${path}: resolves outside the job directory (${real})`)
  return real
}

// The companion to provenance: every output file a job produced, with the bytes and hash the job left behind. A path is
// resolved against the real job directory, so a symlink that points out is refused here as it would be by the runner
// (B1-T5). The entries keep the caller's order: it is usually the order the adapter wrote them in.
export async function manifestOf(
  jobDir: string,
  entries: readonly { path: string; source: ManifestEntry["source"] }[],
): Promise<AssetManifest> {
  const root = await realpath(jobDir)
  const assets: ManifestEntry[] = []
  for (const entry of entries) {
    const real = await resolveInside(root, entry.path)
    const info = await stat(real)
    if (!info.isFile()) throw new Error(`${entry.path}: expected a file, got a directory`)
    assets.push({
      path: entry.path,
      bytes: info.size,
      sha256: await sha256File(real),
      source: entry.source,
    })
  }
  return { assets }
}

// What changed since the manifest was written. Missing, changed and outside are kept apart because they call for
// different answers: a missing file was deleted, a changed one was rewritten, an outside one is now something else
// entirely. An *extra* file on disk is not an error: the runner and the adapters leave temp files behind, and a manifest
// is a lower bound — the list of files the job promised, not a claim that the directory holds nothing else.
export async function verifyManifest(
  jobDir: string,
  manifest: AssetManifest,
): Promise<{ ok: boolean; missing: readonly string[]; changed: readonly string[]; outside: readonly string[] }> {
  const missing: string[] = []
  const changed: string[] = []
  const outside: string[] = []

  let root: string | undefined
  try {
    root = await realpath(jobDir)
  } catch {
    root = undefined
  }

  for (const entry of manifest.assets) {
    const problem = pathProblem(entry.path)
    if (problem) {
      // A path that could not be inside the job lexically has no other place to be reported.
      outside.push(entry.path)
      continue
    }
    if (root === undefined) {
      missing.push(entry.path)
      continue
    }
    let real: string
    try {
      real = await realpath(join(root, entry.path))
    } catch {
      missing.push(entry.path)
      continue
    }
    if (!insidePath(root, real)) {
      outside.push(entry.path)
      continue
    }
    let info
    try {
      info = await stat(real)
    } catch {
      missing.push(entry.path)
      continue
    }
    if (!info.isFile()) {
      missing.push(entry.path)
      continue
    }
    if (info.size !== entry.bytes || (await sha256File(real)) !== entry.sha256) changed.push(entry.path)
  }

  return { ok: missing.length === 0 && changed.length === 0 && outside.length === 0, missing, changed, outside }
}
