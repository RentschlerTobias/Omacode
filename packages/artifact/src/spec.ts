// The four artifact contracts (B1-T1): a deck, a video, a site and an image set are data before they are files. An
// adapter — the deck builder, the video renderer, the site generator, the image generator — receives one of these specs,
// checks it against this file, and only then writes anything. These types are the only description of that data the
// rest of the plugin may rely on; an adapter that needs a key of its own has invented a second contract.
//
// Validation is hand-written, and strict, with no dependency behind it, because the spec is what gets hashed for
// provenance (B1-T3) and what the checks registry (B1-T2) addresses by path. Unknown keys are refused at every level: a
// mistyped key that were dropped silently would let two different specs hash the same, and would let a check pass
// against a field that was never there. The escape hatch is the version, not permissiveness — a spec that needs a new
// key has to say a version this file knows, and a version it does not is refused.
//
// Paths inside a spec are always relative to the job directory, and this file checks that lexically only: the host
// runner (B1-T5) is what resolves a path against the real job and decides whether the bytes behind it stay inside.
// Nothing here touches the filesystem.
//
// `checks` is a list of ids the spec *selects*, never a definition of one: the checks live in the registry (B1-T2), so
// a spec cannot invent a check that the quality gate would then have to trust.

export const ARTIFACT_KINDS = ["deck", "video", "site", "images"] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

// The version of each kind's contract. One counter for all four would tie three unchanged contracts to every change in
// the fourth: the deck gained reveals, branches and hotspots in B3-T1, and a shared number would have declared a video, a
// site and an image set written the day before invalid for a reason none of them had. A version moves when that kind's
// description changes, and only then. Read through `specVersionOf`, so no caller spells a number that a later bump would
// leave behind.
export const SPEC_VERSIONS = {
  deck: 2,
  video: 1,
  site: 1,
  images: 1,
} as const satisfies Record<ArtifactKind, number>

// The version a spec of this kind has to carry. A function rather than a lookup at every call site, so the parser and
// the handoff cannot disagree about which number belongs to a kind.
export function specVersionOf(kind: ArtifactKind): number {
  return SPEC_VERSIONS[kind]
}

type SpecVersion<K extends ArtifactKind> = (typeof SPEC_VERSIONS)[K]

export interface AssetRef {
  readonly path: string
  readonly sha256?: string
}

// What every spec carries, whatever it describes. The kind and version are what make a spec self-describing: a file
// found later, without the process that wrote it, can still be checked against this file. The version is the kind's own,
// so a deck says 2 and a video, a site and an image set say 1.
interface SpecBase<K extends ArtifactKind> {
  readonly kind: K
  readonly version: SpecVersion<K>
  readonly job: string
  readonly brief: string
  readonly checks?: readonly string[]
  readonly assets?: readonly AssetRef[]
}

// A branch button on a slide. `target` names a branch of the same deck: the player turns it into a link between
// sequences, and a link to nothing is an error there rather than a dead button here. The target is checked once every
// branch has been read, because a hotspot may point forwards.
export interface Hotspot {
  readonly id: string
  readonly label: string
  readonly target: string
}

// A branch: the slides a hotspot leads to. The player keeps these apart from the main line as `slideSequences`, so a
// branch is a sequence of slides and not a slide that happens to be hidden.
export interface Branch {
  readonly id: string
  readonly label: string
  readonly slides: readonly Slide[]
}

export interface Slide {
  readonly id: string
  readonly title?: string
  readonly body?: string
  readonly notes?: string
  readonly hidden?: boolean
  readonly asset?: string
  // The fragment indices this slide uncovers. The order the author wrote is kept (canonicalJson leaves arrays alone):
  // the slideshow manifest is written sorted and the player reads `fragments` as a set, so [2, 0] and [0, 2] reveal the
  // same thing, and reordering them here would make two identical decks hash differently.
  readonly reveals?: readonly number[]
  readonly hotspots?: readonly Hotspot[]
}

export interface DeckSpec extends SpecBase<"deck"> {
  readonly slides: readonly Slide[]
  readonly branches?: readonly Branch[]
  readonly theme?: { readonly name: string }
}

export interface Scene {
  readonly id: string
  readonly title?: string
  readonly duration: number
  readonly asset?: string
  readonly captions?: readonly string[]
}

export interface VideoSpec extends SpecBase<"video"> {
  readonly fps: number
  readonly size: { readonly width: number; readonly height: number }
  readonly scenes: readonly Scene[]
}

export interface Page {
  readonly path: string
  readonly title: string
  readonly sections?: readonly string[]
}

export interface SiteSpec extends SpecBase<"site"> {
  readonly pages: readonly Page[]
}

export interface Slot {
  readonly id: string
  readonly prompt: string
  readonly size: { readonly width: number; readonly height: number }
  readonly seed?: number
  readonly negative?: string
  readonly refs?: readonly string[]
}

export interface ImagesSpec extends SpecBase<"images"> {
  readonly slots: readonly Slot[]
}

export type Spec = DeckSpec | VideoSpec | SiteSpec | ImagesSpec

// A parse either yields the spec or the reasons it is not one, never both. Errors are path-addressed, because the person
// fixing the spec is looking at a JSON file and an adapter's check will fire at the same address.
export interface SpecParse {
  readonly spec?: Spec
  readonly errors: readonly string[]
}

type Errors = string[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// How a wrong value is described: its type, not its bytes. A path already says where the value is, and dumping a long
// string into the error would bury the address that makes it actionable.
const got = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

// A value as the reader wrote it, for the two fields where the value itself is the diagnosis rather than its type.
const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

const topic = (path: string): string => (path ? `${path}: ` : "")
const child = (path: string, key: string): string => (path ? `${path}.${key}` : key)
const at = (path: string, index: number): string => `${path}[${index}]`

// A record with exactly these keys. An unknown key is an error at its own address: at the top level it is "extra", in
// the third slide it is "slides[2].extra", which is what the reader needs to fix.
function record(value: unknown, path: string, keys: readonly string[], errors: Errors): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push(`${topic(path)}expected an object, got ${got(value)}`)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(`${child(path, key)}: unknown key`)
  }
  return value
}

// A required string. `nonEmpty` is for the names and the asked-for text: an empty job id or slide id is not something
// a later check can point at, so it is refused where it is written.
function str(obj: Record<string, unknown>, key: string, path: string, errors: Errors, nonEmpty = false): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    errors.push(`${p}: required`)
    return
  }
  if (typeof value !== "string") {
    errors.push(`${p}: expected a string, got ${got(value)}`)
    return
  }
  if (nonEmpty && !value) errors.push(`${p}: expected a non-empty string`)
}

function optStr(obj: Record<string, unknown>, key: string, path: string, errors: Errors): void {
  const value = obj[key]
  if (value === undefined) return
  if (typeof value !== "string") errors.push(`${child(path, key)}: expected a string, got ${got(value)}`)
}

function flag(obj: Record<string, unknown>, key: string, path: string, errors: Errors): void {
  const value = obj[key]
  if (value === undefined) return
  if (typeof value !== "boolean") errors.push(`${child(path, key)}: expected a boolean, got ${got(value)}`)
}

// A number in a stated range. The range is in the message so that whoever reads the error does not have to find this
// file to learn what was expected of the field.
function num(
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

// A required nested object with a known key set. A theme with a typo inside it fails like any other record.
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

// A required list with at least one entry — a deck with no slides, a site with no pages, an image set with no slots is
// not an empty artifact, it is a spec that would produce nothing. Each entry is validated at its index, which is what
// makes an error say `slides[2]` instead of "a slide".
function list(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: Errors,
  each: (value: unknown, path: string, errors: Errors) => void,
): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    errors.push(`${p}: required`)
    return
  }
  if (!Array.isArray(value)) {
    errors.push(`${p}: expected an array, got ${got(value)}`)
    return
  }
  if (!value.length) {
    errors.push(`${p}: expected at least one entry`)
    return
  }
  value.forEach((item, index) => each(item, at(p, index), errors))
}

// An optional list. A deck may carry no branches at all, so absence and an empty list say the same thing — there is
// nowhere to branch to — and neither is an error. Each entry is still validated at its index, like a required list.
function optList(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: Errors,
  each: (value: unknown, path: string, errors: Errors) => void,
): void {
  const value = obj[key]
  if (value === undefined) return
  const p = child(path, key)
  if (!Array.isArray(value)) {
    errors.push(`${p}: expected an array, got ${got(value)}`)
    return
  }
  value.forEach((item, index) => each(item, at(p, index), errors))
}

// A list of strings: slide captions, page sections, checks. Optional, and empty when it would say nothing.
function texts(obj: Record<string, unknown>, key: string, path: string, errors: Errors): void {
  const value = obj[key]
  if (value === undefined) return
  const p = child(path, key)
  if (!Array.isArray(value)) {
    errors.push(`${p}: expected an array of strings, got ${got(value)}`)
    return
  }
  value.forEach((item, index) => {
    if (typeof item !== "string") errors.push(`${at(p, index)}: expected a string, got ${got(item)}`)
  })
}

// Why a path is not a job-relative one. The check is lexical on purpose: `..` is refused here even where it would stay
// inside the job, because the spec does not know where the job is. Only the host runner (B1-T5) can say that.
function pathProblem(value: string): string | undefined {
  if (!value) return "a path must not be empty"
  if (value.startsWith("/")) return "a path must be relative to the job directory"
  if (value.includes("\\")) return 'a path must use "/" as its separator'
  const segments = value.split("/")
  if (segments.includes(".") || segments.includes("..")) return 'a path must not contain "." or ".." segments'
  if (segments.includes("")) return "a path must not contain an empty segment"
  return undefined
}

function checkPath(value: unknown, path: string, errors: Errors): void {
  if (typeof value !== "string") {
    errors.push(`${path}: expected a string, got ${got(value)}`)
    return
  }
  const problem = pathProblem(value)
  if (problem) errors.push(`${path}: ${problem}, got ${shown(value)}`)
}

function pathField(obj: Record<string, unknown>, key: string, path: string, errors: Errors, required: boolean): void {
  const p = child(path, key)
  const value = obj[key]
  if (value === undefined) {
    if (required) errors.push(`${p}: required`)
    return
  }
  checkPath(value, p, errors)
}

// The reference images a slot may be drawn from: optional, each one job-relative like every other path.
function pathList(obj: Record<string, unknown>, key: string, path: string, errors: Errors): void {
  const value = obj[key]
  if (value === undefined) return
  const p = child(path, key)
  if (!Array.isArray(value)) {
    errors.push(`${p}: expected an array of paths, got ${got(value)}`)
    return
  }
  value.forEach((item, index) => checkPath(item, at(p, index), errors))
}

const SIZE_KEYS = ["width", "height"] as const

// A size is pixels, so it is two positive integers and nothing else. The key set is enforced here too: a size that
// grew a "units" key is a size this contract does not know, and a renderer that silently ignored it would be wrong.
function sizeField(obj: Record<string, unknown>, key: string, path: string, errors: Errors): void {
  objField(obj, key, path, errors, SIZE_KEYS, (value, p) => {
    num(value, "width", p, errors, "a positive integer", (n) => Number.isInteger(n) && n > 0)
    num(value, "height", p, errors, "a positive integer", (n) => Number.isInteger(n) && n > 0)
  })
}

const ASSET_KEYS = ["path", "sha256"] as const
const BASE_KEYS = ["kind", "version", "job", "brief", "checks", "assets"] as const
const SLIDE_KEYS = ["id", "title", "body", "notes", "hidden", "asset", "reveals", "hotspots"] as const
const HOTSPOT_KEYS = ["id", "label", "target"] as const
const BRANCH_KEYS = ["id", "label", "slides"] as const
const SCENE_KEYS = ["id", "title", "duration", "asset", "captions"] as const
const PAGE_KEYS = ["path", "title", "sections"] as const
const SLOT_KEYS = ["id", "prompt", "size", "seed", "negative", "refs"] as const
const THEME_KEYS = ["name"] as const

// The base fields are checked by one function for all four kinds, so a deck and a site cannot drift apart on what a
// job id or a selected check is.
function base(obj: Record<string, unknown>, kind: ArtifactKind, errors: Errors): void {
  const stated = obj["kind"]
  if (stated === undefined) errors.push("kind: required")
  else if (stated !== kind) errors.push(`kind: expected ${shown(kind)}, got ${shown(stated)}`)

  const supported = specVersionOf(kind)
  const version = obj["version"]
  if (version === undefined) errors.push("version: required")
  else if (version !== supported) errors.push(`version: a ${kind} spec is version ${supported}, got ${shown(version)}`)

  str(obj, "job", "", errors, true)
  str(obj, "brief", "", errors, true)
  texts(obj, "checks", "", errors)

  const assets = obj["assets"]
  if (assets === undefined) return
  if (!Array.isArray(assets)) {
    errors.push(`assets: expected an array, got ${got(assets)}`)
    return
  }
  assets.forEach((item, index) => {
    const p = at("assets", index)
    const ref = record(item, p, ASSET_KEYS, errors)
    if (!ref) return
    pathField(ref, "path", p, errors, true)
    optStr(ref, "sha256", p, errors)
  })
}

// What one deck's slides and branches have to agree on, collected while the deck is read. The slide ids span the main
// line and every branch because a slide id is a scene id in the composition; the branch ids and the hotspot targets meet
// only after both lists are read, because a hotspot may point forwards.
interface DeckState {
  readonly slideIds: Map<string, string>
  readonly branchIds: Map<string, string>
  readonly hotspots: { readonly path: string; readonly target: string }[]
}

// The player's own id for the line the deck starts on. HyperFrames keeps the main line apart from `slideSequences` and
// calls it `main`; a branch that took the name would shadow the thing the player already means by it, so the id is
// refused where it is written rather than left for the manifest to collide with.
const MAIN_LINE = "main"

// The fragment indices a slide reveals. A fragment is a position in the slide's own build order, so the index is a
// non-negative integer written once; a negative or fractional one would be rounded or ignored somewhere the spec cannot
// see. Duplicates are refused because `fragments` is a set: a second 2 would be dropped and the spec would say less than
// it was written to say.
function revealList(obj: Record<string, unknown>, path: string, errors: Errors): void {
  const value = obj["reveals"]
  if (value === undefined) return
  const p = child(path, "reveals")
  if (!Array.isArray(value)) {
    errors.push(`${p}: expected an array of fragment indices, got ${got(value)}`)
    return
  }
  const seen = new Set<number>()
  value.forEach((item, index) => {
    const q = at(p, index)
    if (typeof item !== "number") {
      errors.push(`${q}: expected a non-negative integer, got ${got(item)}`)
      return
    }
    if (!Number.isInteger(item) || item < 0) {
      errors.push(`${q}: expected a non-negative integer, got ${String(item)}`)
      return
    }
    if (seen.has(item)) errors.push(`${q}: duplicate fragment index ${item}`)
    seen.add(item)
  })
}

// The branch buttons on a slide. An id is what a click is addressed by, so it is unique on its slide; the target is only
// collected here and checked against the branches once the whole deck has been read.
function hotspotList(obj: Record<string, unknown>, path: string, errors: Errors, state: DeckState): void {
  const value = obj["hotspots"]
  if (value === undefined) return
  const p = child(path, "hotspots")
  if (!Array.isArray(value)) {
    errors.push(`${p}: expected an array, got ${got(value)}`)
    return
  }
  const seen = new Set<string>()
  value.forEach((item, index) => {
    const q = at(p, index)
    const hotspot = record(item, q, HOTSPOT_KEYS, errors)
    if (!hotspot) return
    str(hotspot, "id", q, errors, true)
    str(hotspot, "label", q, errors, true)
    str(hotspot, "target", q, errors)
    const id = hotspot["id"]
    if (typeof id === "string" && id) {
      if (seen.has(id)) errors.push(`${child(q, "id")}: duplicate hotspot id ${shown(id)} on this slide`)
      seen.add(id)
    }
    // An empty target is collected too: it names no branch, and that is the sentence the reader needs.
    const target = hotspot["target"]
    if (typeof target === "string") state.hotspots.push({ path: child(q, "target"), target })
  })
}

function slide(value: unknown, path: string, errors: Errors, state: DeckState): void {
  const obj = record(value, path, SLIDE_KEYS, errors)
  if (!obj) return
  str(obj, "id", path, errors, true)
  const id = obj["id"]
  if (typeof id === "string" && id) {
    const first = state.slideIds.get(id)
    // A slide id is a scene id in the composition, and the player names every scene once. A branch slide that repeated a
    // main-line id would be two scenes nothing can tell apart, so both addresses are in the sentence.
    if (first === undefined) state.slideIds.set(id, path)
    else errors.push(`${child(path, "id")}: slide id ${shown(id)} is already used at ${first}`)
  }
  optStr(obj, "title", path, errors)
  optStr(obj, "body", path, errors)
  optStr(obj, "notes", path, errors)
  flag(obj, "hidden", path, errors)
  pathField(obj, "asset", path, errors, false)
  revealList(obj, path, errors)
  hotspotList(obj, path, errors, state)
}

// A branch is a sequence of slides a hotspot can lead to, so it needs an id to be pointed at, a label to be shown and
// at least one slide to show. Its slides are checked like the main line's, including the ids that are shared with it.
function branch(value: unknown, path: string, errors: Errors, state: DeckState): void {
  const obj = record(value, path, BRANCH_KEYS, errors)
  if (!obj) return
  str(obj, "id", path, errors, true)
  const id = obj["id"]
  if (typeof id === "string" && id) {
    if (id === MAIN_LINE) {
      errors.push(`${child(path, "id")}: ${shown(MAIN_LINE)} is the player's own id for the main line, so a branch cannot use it`)
    } else {
      const first = state.branchIds.get(id)
      if (first === undefined) state.branchIds.set(id, path)
      else errors.push(`${child(path, "id")}: branch id ${shown(id)} is already used at ${first}`)
    }
  }
  str(obj, "label", path, errors, true)
  list(obj, "slides", path, errors, (value, nested, nestedErrors) => slide(value, nested, nestedErrors, state))
}

function deck(obj: Record<string, unknown>, errors: Errors): void {
  const state: DeckState = { slideIds: new Map(), branchIds: new Map(), hotspots: [] }
  list(obj, "slides", "", errors, (value, path, nestedErrors) => slide(value, path, nestedErrors, state))
  optList(obj, "branches", "", errors, (value, path, nestedErrors) => branch(value, path, nestedErrors, state))
  // Only now can a hotspot be checked: the branch it names may have been written after the slide that links to it.
  for (const hotspot of state.hotspots) {
    if (!state.branchIds.has(hotspot.target)) errors.push(`${hotspot.path}: names no branch (${shown(hotspot.target)})`)
  }
  optObjField(obj, "theme", "", errors, THEME_KEYS, (theme, p) => str(theme, "name", p, errors, true))
}

function scene(value: unknown, path: string, errors: Errors): void {
  const obj = record(value, path, SCENE_KEYS, errors)
  if (!obj) return
  str(obj, "id", path, errors, true)
  optStr(obj, "title", path, errors)
  num(obj, "duration", path, errors, "a number of seconds greater than 0", (n) => n > 0)
  pathField(obj, "asset", path, errors, false)
  texts(obj, "captions", path, errors)
}

function video(obj: Record<string, unknown>, errors: Errors): void {
  num(obj, "fps", "", errors, "a number greater than 0 and at most 240", (n) => n > 0 && n <= 240)
  sizeField(obj, "size", "", errors)
  list(obj, "scenes", "", errors, scene)
}

function page(value: unknown, path: string, errors: Errors): void {
  const obj = record(value, path, PAGE_KEYS, errors)
  if (!obj) return
  pathField(obj, "path", path, errors, true)
  str(obj, "title", path, errors, true)
  texts(obj, "sections", path, errors)
}

function site(obj: Record<string, unknown>, errors: Errors): void {
  list(obj, "pages", "", errors, page)
}

function slot(value: unknown, path: string, errors: Errors): void {
  const obj = record(value, path, SLOT_KEYS, errors)
  if (!obj) return
  str(obj, "id", path, errors, true)
  str(obj, "prompt", path, errors, true)
  sizeField(obj, "size", path, errors)
  // A seed is an integer in every generator this contract will meet; a fractional one would be rounded somewhere the
  // spec cannot see, so it is refused here instead.
  num(obj, "seed", path, errors, "an integer", (n) => Number.isInteger(n), false)
  optStr(obj, "negative", path, errors)
  pathList(obj, "refs", path, errors)
}

function images(obj: Record<string, unknown>, errors: Errors): void {
  list(obj, "slots", "", errors, slot)
}

// The keys each kind adds to the base. One table, so the parser and the unknown-key check cannot disagree about what a
// deck is allowed to say.
const KIND_KEYS: Record<ArtifactKind, readonly string[]> = {
  deck: [...BASE_KEYS, "slides", "branches", "theme"],
  video: [...BASE_KEYS, "fps", "size", "scenes"],
  site: [...BASE_KEYS, "pages"],
  images: [...BASE_KEYS, "slots"],
}

const CHECKS: Record<ArtifactKind, (obj: Record<string, unknown>, errors: Errors) => void> = { deck, video, site, images }

// Read one artifact spec. The value is whatever came out of JSON.parse, so it is checked field by field and not cast
// into shape: a spec that parses is the object the author wrote, which is what makes `canonicalJson` below hash the
// same bytes for the same spec.
export function parseSpec(kind: ArtifactKind, value: unknown): SpecParse {
  const errors: Errors = []
  if (!ARTIFACT_KINDS.includes(kind)) {
    errors.push(`kind: unknown artifact kind ${shown(kind)}`)
    return { errors }
  }
  const obj = record(value, "", KIND_KEYS[kind], errors)
  if (!obj) return { errors }
  base(obj, kind, errors)
  CHECKS[kind](obj, errors)
  return errors.length ? { errors } : { spec: obj as unknown as Spec, errors }
}

// Deterministic JSON, for the provenance hash (B1-T3): object keys sorted at every depth, arrays left in their order
// (a slide list is ordered, an asset list is not a set). Two specs that say the same thing then hash the same, however
// the author happened to order the keys.
export function canonicalJson(value: unknown): string {
  const order = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(order)
    if (isRecord(item)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(item).sort()) sorted[key] = order(item[key])
      return sorted
    }
    return item
  }
  return JSON.stringify(order(value))
}
