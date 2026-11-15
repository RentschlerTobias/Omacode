// B1-T6: what a plan job leaves behind, read back as an artifact spec. A plan's `plan.md` is prose for a reader; the
// `## Artifacts` section under it lists the files the job promoted out of its throwaway worktree, each with its bytes
// and sha256, and src/promote.ts put those files under <planArea>/artifacts/<task>/. The build job that follows must not
// re-read the prose: it takes the document and the goal and gets one of the four specs (B1-T1), which is what the
// deck/video/site/image adapter renders.
//
// The document is the only thing that says a file is what the plan built, so the hashes are checked rather than trusted:
// a plan.md that names a file whose bytes changed, or whose hash is not its own, is refused. A file the chosen kind
// cannot use is named in `warnings`, never dropped: a deck plan that also promoted a screen recording should say so, not
// quietly produce a deck from less than the plan handed over.
//
// Every path in the returned spec is relative to `artifactsRoot`, because that is where the files are; a caller that
// stages them into its own job directory keeps the same shape, so the spec stays true after the copy. This module may
// import the plugin's own code (plandoc.ts, worktree/git.ts) — @omacode/artifact must never import the plugin — which
// is why the handoff lives beside the plan rather than in the package.

import { closeSync, openSync, readSync } from "node:fs"
import { stat } from "node:fs/promises"
import { extname, join } from "node:path"

import { insidePath } from "@omacode/artifact/paths"
import { sha256File } from "@omacode/artifact/provenance"
import { SPEC_VERSION, parseSpec, type ArtifactKind, type Page, type Scene, type Slide, type Slot, type Spec } from "@omacode/artifact/spec"

import { parsePlanDoc } from "../plandoc.ts"
import { planArea } from "../worktree/git.ts"

// Where promoted artifacts land: the same root src/promote.ts writes under, so a spec path and the file on disk are one
// relative name. The caller passes this in instead of resolving it twice, and a job that copies the files keeps it.
export function artifactsRootFor(project: string, jobId: string): string {
  return join(planArea(project, jobId), "artifacts")
}

export interface HandoffInput {
  readonly planMd: string
  readonly artifactsRoot: string
  readonly kind: ArtifactKind
  readonly job: string
  readonly brief: string
  readonly checks?: readonly string[]
}

export interface Handoff {
  readonly spec?: Spec
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  readonly used: readonly { readonly task: string; readonly path: string; readonly sha256: string }[]
}

// The mapping, one row per kind: what a promoted file has to be called to become an item. A file of any other extension
// is reported, not guessed at.
const EXTENSIONS: Record<ArtifactKind, readonly string[]> = {
  deck: [".html", ".md"],
  video: [".mp4", ".webm", ".mov"],
  site: [".html"],
  images: [".png", ".jpg", ".jpeg", ".webp"],
}

// What plan.md does not carry. Each default is used with a warning naming it, because a scene without a duration or a
// slot without a size cannot be built, and an adapter must not have to invent the number this module already picked.
const DEFAULT_DURATION = 5
const DEFAULT_FPS = 30
const DEFAULT_SIZE = { width: 1920, height: 1080 } as const
const DEFAULT_IMAGE_SIZE = { width: 1024, height: 1024 } as const

// How much of a file is read for its heading. A title is the first line of a document or the first element of a page;
// reading past a long body would only cost memory for text a heading never uses.
const HEAD_BYTES = 64 * 1024

// A file that passed the checks, before the kind decides what to make of it.
interface Verified {
  readonly task: string
  readonly path: string // as plan.md names it, below the task's directory
  readonly asset: string // `<task>/<path>`, which is how the spec's assets name it
  readonly abs: string
  readonly sha256: string
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// The first bytes of a file as text. Decoding may cut a multi-byte character at the boundary; the only victim is a
// heading that starts past 64 KiB, which is not a heading a reader would have found either.
function headOf(path: string): string {
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

// The first heading of an artifact: `# ` for Markdown, the first non-empty `<h1>` for HTML. Undefined when there is
// none, which the caller answers with the file's stem — a slide still needs something to call it.
function headingIn(text: string, kind: string): string | undefined {
  if (kind === ".html") {
    for (const found of text.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)) {
      const title = found[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
      if (title) return title
    }
    return undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const found = /^#\s+(.*)$/.exec(line)
    const title = found?.[1]?.trim()
    if (title) return title
  }
  return undefined
}

// The name without its extension: `sub/page.html` → `page`. The stem is the fallback title and, for an image slot, the
// only prompt there is.
function stemOf(path: string): string {
  const name = path.split("/").pop() ?? path
  return name.endsWith(extname(name)) ? name.slice(0, name.length - extname(name).length) : name
}

// A spec id from a path: readable in an error and stable across runs, since it is derived from what plan.md says.
function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"
}

// Two artifacts can share a stem (`deck.html` and `deck.md`, or the same name in two tasks). A spec id is a promise that
// a later check can address one item, so a duplicate is numbered rather than left to collide.
function uniqueId(base: string, seen: Set<string>): string {
  let id = base
  for (let n = 2; seen.has(id); n++) id = `${base}-${n}`
  seen.add(id)
  return id
}

async function titleOf(file: Verified): Promise<string> {
  const extension = extname(file.path).toLowerCase()
  let head: string
  try {
    head = headOf(file.abs)
  } catch {
    // The bytes just hashed a moment ago, so an unreadable file here is a race, not a contract problem: the stem is
    // still a truthful name and the spec can be built.
    return stemOf(file.path)
  }
  return headingIn(head, extension) ?? stemOf(file.path)
}

// Read a plan document and map its promoted artifacts into one typed spec. The spec is returned only when the whole
// handoff holds: a document that does not parse, a file whose hash or size is not the one the document records, or a
// plan that promotes nothing this kind can use has no spec to give an adapter.
export async function specFromPlan(input: HandoffInput): Promise<Handoff> {
  const warnings: string[] = []
  const parsed = parsePlanDoc(input.planMd)
  if (!parsed.doc) return { errors: parsed.errors.map((line) => `plan.md: ${line}`), warnings, used: [] }
  const doc = parsed.doc

  // A1's rule: a reader-only plan promotes nothing, so there is nothing to hand an adapter. Saying that is better than
  // handing back an empty deck that would render as a blank file.
  if (doc.readerOnly !== undefined) {
    return { errors: ["the plan is reader-only, so there is nothing to hand over"], warnings, used: [] }
  }

  const errors: string[] = []
  const verified: Verified[] = []
  for (const artifact of doc.artifacts) {
    const label = `${artifact.task}/${artifact.path}`
    const abs = join(input.artifactsRoot, artifact.task, ...artifact.path.split("/"))
    // `insidePath` resolves both sides through `realish`, so a `..` that climbs out and a symlink that points out are
    // the same refusal; a name that merely looks harmless is not enough for a path built from a document.
    if (!insidePath(input.artifactsRoot, abs)) {
      errors.push(`${label} resolves outside the artifacts root`)
      continue
    }
    let info
    try {
      info = await stat(abs)
    } catch (err) {
      errors.push(`${label}: cannot be read (${why(err)})`)
      continue
    }
    if (!info.isFile()) {
      errors.push(`${label}: expected a file, not a directory`)
      continue
    }
    const sha256 = await sha256File(abs)
    if (sha256 !== artifact.sha256) {
      errors.push(`${label}: plan.md records sha256 ${artifact.sha256}, but the file hashes to ${sha256}`)
      continue
    }
    if (info.size !== artifact.bytes) {
      errors.push(`${label}: plan.md records ${artifact.bytes} B, but the file is ${info.size} B`)
      continue
    }
    verified.push({ task: artifact.task, path: artifact.path, asset: label, abs, sha256 })
  }

  // The files this kind can use, and a word about every one it cannot. The order of `warnings` follows plan.md.
  const usable: Verified[] = []
  for (const file of verified) {
    if (EXTENSIONS[input.kind].includes(extname(file.path).toLowerCase())) usable.push(file)
    else warnings.push(`${file.asset} is not used by a ${input.kind} spec`)
  }

  // A broken file is a broken handoff even when the rest would build: the plan is the only claim about which bytes are
  // the job's, and a caller that shipped a deck from half of them would never learn the other half was wrong.
  if (errors.length) return { errors, warnings, used: [] }
  if (!usable.length) {
    errors.push(`the plan promotes no file a ${input.kind} spec can use`)
    return { errors, warnings, used: [] }
  }

  const base = {
    version: SPEC_VERSION,
    job: input.job,
    brief: input.brief,
    ...(input.checks !== undefined ? { checks: [...input.checks] } : {}),
    assets: usable.map((file) => ({ path: file.asset, sha256: file.sha256 })),
  }
  const used: { task: string; path: string; sha256: string }[] = []
  const seen = new Set<string>()
  let built: unknown

  if (input.kind === "deck") {
    const slides: Slide[] = []
    for (const file of usable) {
      slides.push({ id: uniqueId(slugOf(file.asset), seen), title: await titleOf(file), asset: file.asset })
      // The spec names the file by its asset path, so that is the path provenance records.
      used.push({ task: file.task, path: file.asset, sha256: file.sha256 })
    }
    built = { kind: "deck", ...base, slides }
  } else if (input.kind === "video") {
    warnings.push(`plan.md carries no fps, so the spec uses the default ${DEFAULT_FPS} fps`)
    warnings.push(`plan.md carries no frame size, so the spec uses the default ${DEFAULT_SIZE.width}×${DEFAULT_SIZE.height}`)
    const scenes: Scene[] = []
    for (const file of usable) {
      scenes.push({ id: uniqueId(slugOf(file.asset), seen), duration: DEFAULT_DURATION, asset: file.asset })
      warnings.push(`${file.asset}: plan.md carries no duration, so the scene uses the default ${DEFAULT_DURATION} s`)
      used.push({ task: file.task, path: file.asset, sha256: file.sha256 })
    }
    built = {
      kind: "video",
      ...base,
      fps: DEFAULT_FPS,
      size: { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height },
      scenes,
    }
  } else if (input.kind === "site") {
    const pages: Page[] = []
    // A site page is addressed by where it sits in the site, so the task directory the plan used for storage is not part
    // of it — which is why two tasks promoting `sub/page.html` would write one page twice. That is a collision the spec
    // cannot see (both pages are valid on their own), so it is refused here, naming both tasks.
    const owners = new Map<string, string>()
    for (const file of usable) {
      const owner = owners.get(file.path)
      if (owner !== undefined) {
        errors.push(`page ${file.path} is promoted by both ${owner} and ${file.task}`)
        continue
      }
      owners.set(file.path, file.task)
      pages.push({ path: file.path, title: await titleOf(file) })
      used.push({ task: file.task, path: file.path, sha256: file.sha256 })
    }
    if (errors.length) return { errors, warnings, used: [] }
    built = { kind: "site", ...base, pages }
  } else {
    const slots: Slot[] = []
    for (const file of usable) {
      slots.push({ id: uniqueId(slugOf(file.asset), seen), prompt: stemOf(file.path), size: { ...DEFAULT_IMAGE_SIZE } })
      warnings.push(`${file.asset}: plan.md carries no prompt, so the slot's prompt is the file's name`)
      warnings.push(
        `${file.asset}: plan.md carries no size, so the slot uses the default ${DEFAULT_IMAGE_SIZE.width}×${DEFAULT_IMAGE_SIZE.height}`,
      )
      used.push({ task: file.task, path: file.asset, sha256: file.sha256 })
    }
    built = { kind: "images", ...base, slots }
  }

  // The spec's own parser is the last word: a mapping this file got wrong (a task id that is not a path segment, an
  // empty brief) fails here, where a caller can still say why, instead of inside the adapter.
  const spec = parseSpec(input.kind, built)
  if (!spec.spec) return { errors: spec.errors, warnings, used: [] }
  return { spec: spec.spec, errors: [], warnings, used }
}
