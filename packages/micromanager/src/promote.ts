// What a plan worker hands back, checked path by path before a single byte is copied. Plan mode is a hard boundary
// (docs/roadmap/omacode-roadmap.md §5, A1): a planner drafts in a throwaway worktree under the state directory, and the
// only thing that leaves it is what its report names on an `Artifacts:` line. That line is worker-written text, so it is
// treated as an attack until it proves otherwise: no symlinks anywhere on the way (a link is how a harmless-looking name
// turns into /etc/shadow), no FIFOs, sockets or devices, no absolute paths, no ".." that climbs out, no path that
// resolves outside the worktree, a size cap and a secret scan. The copy itself opens each source with O_NOFOLLOW, so a
// link created between the check and the copy is not followed either.
//
// A rejection is per path and does not stop the others, but `ok` is false for the whole report: the caller must not mark
// the task passed while a path it named was refused.

import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs"
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"

import { MAX_FILE_BYTES, SECRET } from "./nogit.ts"
import { findSecrets } from "./redact.ts"
import { planArea } from "./worktree/git.ts"

// The whole report may not carry more than this, however many files it names: a plan is a draft, not a data transfer.
export const MAX_PROMOTED_BYTES = 64 * 1024 * 1024
// How much of a file is scanned for secrets. A secret past the first MiB is not found, which is stated, not fixed here:
// a bigger window only moves the line, and no plan artifact is a secret store.
const SCAN_BYTES = 1024 * 1024

export interface PromoteInput {
  readonly project: string
  readonly jobId: string
  readonly taskId: string
  readonly root: string // the plan worktree root: the boundary a path may not leave
  readonly dir: string // the project directory inside it: report paths are relative to this
  readonly paths: readonly string[] // the report's Artifacts: paths
}

export interface Promotion {
  readonly ok: boolean
  readonly promoted: readonly { path: string; bytes: number; sha256: string }[]
  readonly rejected: readonly { path: string; reason: string }[]
}

interface Candidate {
  readonly rel: string // the destination path, relative to the task's artifacts directory
  readonly abs: string
  readonly bytes: number
  readonly dev: number // what lstat saw: the copy must open this same inode
  readonly ino: number
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// A path as the report wrote it: the surrounding quotes or backticks are formatting, not part of the name.
function strip(raw: string): string {
  const quoted = /^([`"'])([\s\S]*)\1$/.exec(raw.trim())
  return (quoted ? quoted[2]! : raw).trim()
}

// The kind of entry that is never an artifact. Symlinks are reported on their own, because they are the interesting one.
function special(st: Stats): string | undefined {
  if (st.isFIFO()) return "fifo"
  if (st.isSocket()) return "socket"
  if (st.isBlockDevice() || st.isCharacterDevice()) return "device"
  return undefined
}

// Equals or lies under a resolved root, without a sibling whose name merely starts with the same characters.
function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

// Walks to the target one segment at a time from the worktree root, so a link in the middle of the path is seen as what
// it is rather than silently followed by the next lstat.
function walkTo(root: string, segments: readonly string[]): { target: string } | { reason: string } {
  let cur = root
  for (const segment of segments) {
    cur = join(cur, segment)
    let st: Stats
    try {
      st = lstatSync(cur)
    } catch (err) {
      return { reason: `cannot be read: ${why(err)}` }
    }
    if (st.isSymbolicLink()) return { reason: "a symlink in the artifact path" }
  }
  return { target: cur }
}

// The regular files of an artifact, or why it may not be one: a directory is walked whole, and one symlink, FIFO,
// socket or device inside it refuses the directory rather than being skipped.
function collect(target: string, rel: string): { files: Candidate[] } | { reason: string } {
  let st: Stats
  try {
    st = lstatSync(target)
  } catch (err) {
    return { reason: `cannot be read: ${why(err)}` }
  }
  if (st.isSymbolicLink()) return { reason: "a symlink in the artifact path" }
  const kind = special(st)
  if (kind) return { reason: `the artifact is a ${kind}, not a regular file or directory` }
  if (st.isFile()) return { files: [{ rel, abs: target, bytes: st.size, dev: st.dev, ino: st.ino }] }
  if (!st.isDirectory()) return { reason: "the artifact is not a regular file or directory" }
  const files: Candidate[] = []
  const walk = (abs: string, relDir: string): string | undefined => {
    let names: string[]
    try {
      names = readdirSync(abs).sort()
    } catch (err) {
      return `cannot be read: ${why(err)}`
    }
    for (const name of names) {
      const child = join(abs, name)
      const childRel = `${relDir}/${name}`
      let cst: Stats
      try {
        cst = lstatSync(child)
      } catch (err) {
        return `cannot be read: ${why(err)}`
      }
      if (cst.isSymbolicLink()) return `nested symlink in ${childRel}`
      const childKind = special(cst)
      if (childKind) return `nested ${childKind} in ${childRel}`
      if (cst.isDirectory()) {
        const nested = walk(child, childRel)
        if (nested) return nested
        continue
      }
      if (!cst.isFile()) return `nested special file in ${childRel}`
      files.push({ rel: childRel, abs: child, bytes: cst.size, dev: cst.dev, ino: cst.ino })
    }
    return undefined
  }
  const nested = walk(target, rel)
  return nested ? { reason: nested } : { files }
}

// One file: opened without following a link, then checked against the inode `lstat` saw. O_NOFOLLOW covers the last
// component only, so a parent directory swapped for a symlink between the check and the copy would otherwise be
// followed; the descriptor's own dev/ino is what proves the bytes come from the file that was inspected.
// The same buffer is scanned for a secret, hashed and written 0600 under a 0700 parent, so the record describes exactly
// the bytes that landed. Exported for its own test: the race it closes cannot be reproduced from outside.
export function copyOne(src: string, dest: string, expect: { readonly dev: number; readonly ino: number }): { bytes: number; sha256: string } | { reason: string } {
  let fd: number | undefined
  try {
    fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (opened.dev !== expect.dev || opened.ino !== expect.ino) return { reason: "changed while it was checked" }
    const bytes = readFileSync(fd)
    // The lstat before the copy said its size; a file that grew since is refused on the bytes actually read.
    if (bytes.length > MAX_FILE_BYTES) return { reason: "over the size cap" }
    const sample = bytes.subarray(0, SCAN_BYTES)
    // Binary content is not scanned: a NUL in the sample means the file is not text, and a token format cannot be read
    // out of one anyway. A secret in a binary artifact is a limitation of this check, not a promise.
    if (!sample.includes(0)) {
      const found = findSecrets(sample.toString("utf8")).filter((f) => f.kind === "secret")
      if (found.length) return { reason: "contains a secret" }
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
    writeFileSync(dest, bytes, { mode: 0o600 })
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  } catch (err) {
    return { reason: `cannot be copied: ${why(err)}` }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function promoteArtifacts(input: PromoteInput): Promotion {
  const promoted: { path: string; bytes: number; sha256: string }[] = []
  const rejected: { path: string; reason: string }[] = []
  let root: string
  try {
    root = realpathSync(input.root)
  } catch (err) {
    // No worktree, nothing to promote from: every path is refused rather than silently dropped.
    for (const path of input.paths) rejected.push({ path, reason: `the plan worktree cannot be read: ${why(err)}` })
    return { ok: false, promoted, rejected }
  }
  const base = resolve(input.root)
  // Where the project sits inside the worktree: the walk starts at the root, the paths resolve against the project.
  const offset = relative(base, resolve(input.dir)).split(sep).join("/")
  const offsetSegments = offset === "" || offset === "." ? [] : offset.split("/").filter(Boolean)
  const outsideDir = offset === ".." || offset.startsWith("../") || isAbsolute(offset)
  const destRoot = join(planArea(input.project, input.jobId), "artifacts", input.taskId)
  const seen = new Set<string>()

  for (const raw of input.paths) {
    // (a) and (b): formatting off, then a posix path. A benign internal "a/../b" normalises to "b" and is accepted;
    // only a ".." that is still there after normalisation -- which can only be a leading one -- climbs out.
    const given = strip(raw)
    const norm = posix.normalize(given)
    if (isAbsolute(given) || isAbsolute(norm) || given.startsWith("~")) {
      rejected.push({ path: raw, reason: "an absolute path" })
      continue
    }
    if (norm === ".." || norm.startsWith("../") || norm.split("/").includes("..")) {
      rejected.push({ path: raw, reason: "escapes the worktree with `..`" })
      continue
    }
    // (c) a name for a file, not the directory itself and not a directory by its trailing slash.
    if (given === "" || norm === "." || given.endsWith("/")) {
      rejected.push({ path: raw, reason: "names no file" })
      continue
    }
    if (outsideDir) {
      rejected.push({ path: raw, reason: "resolves outside the plan worktree" })
      continue
    }
    // (d) every segment from the root, the project's own offset included.
    const reached = walkTo(base, [...offsetSegments, ...norm.split("/")])
    if ("reason" in reached) {
      rejected.push({ path: raw, reason: reached.reason })
      continue
    }
    const target = reached.target
    // (e) the target itself, and a directory in full.
    const found = collect(target, norm)
    if ("reason" in found) {
      rejected.push({ path: raw, reason: found.reason })
      continue
    }
    const files = found.files
    // (f) the filesystem's own answer, resolving what the walk could not see (a link in a parent the walk did see would
    // already have stopped it; this is the check that no future refactor can skip).
    try {
      if (!inside(realpathSync(target), root)) {
        rejected.push({ path: raw, reason: "resolves outside the plan worktree" })
        continue
      }
    } catch (err) {
      rejected.push({ path: raw, reason: `cannot be read: ${why(err)}` })
      continue
    }
    // (g) the size caps, one file and the artifact whole.
    const total = files.reduce((sum, f) => sum + f.bytes, 0)
    if (files.some((f) => f.bytes > MAX_FILE_BYTES) || total > MAX_PROMOTED_BYTES) {
      rejected.push({ path: raw, reason: "over the size cap" })
      continue
    }
    // (h) a name that says it holds a secret is refused whatever it holds.
    const named = files.find((f) => SECRET.some((re) => re.test(basename(f.abs))))
    if (named) {
      rejected.push({ path: raw, reason: `a secret file name: ${named.rel}` })
      continue
    }
    if (seen.has(norm)) continue // the same path named twice is one artifact
    seen.add(norm)
    // (i) copy; the content scan happens on the bytes that are copied. A rejection part-way through a directory removes
    // what that artifact already wrote, so a refused artifact leaves nothing of itself behind.
    const written: { path: string; bytes: number; sha256: string }[] = []
    let failure: string | undefined
    for (const file of files) {
      const copied = copyOne(file.abs, join(destRoot, ...file.rel.split("/")), file)
      if ("reason" in copied) {
        failure = file.rel === norm ? copied.reason : `${copied.reason} in ${file.rel}`
        break
      }
      written.push({ path: file.rel, bytes: copied.bytes, sha256: copied.sha256 })
    }
    if (failure) {
      try {
        rmSync(join(destRoot, ...norm.split("/")), { recursive: true, force: true })
      } catch {
        // a leftover under the state directory is not an escape, so failing to clean it is not fatal
      }
      rejected.push({ path: raw, reason: failure })
      continue
    }
    promoted.push(...written)
  }
  return { ok: rejected.length === 0, promoted, rejected }
}

// --- The record a plan task leaves behind -----------------------------------------------------------------------

export interface PromotionRecordInput {
  readonly project: string
  readonly jobId: string
  readonly taskId: string
  readonly title: string
  readonly report: string
  readonly promotion: Promotion
  readonly checks: readonly string[]
  readonly git?: { readonly base: string; readonly head: string; readonly patch: string }
}

export interface PromotionRecord {
  readonly manifest: string
  readonly findings: string
  readonly patch?: string
}

// The durable half of a plan task: the worktree it drafted in is thrown away with its branch, so the patch, the
// worker's findings and a manifest of what was handed back are what is left of it. The manifest is the index of the
// record: it names every file and repeats the hash of each promoted artifact, so a reader does not have to trust the
// copies' names. Like the copies, everything is written 0600 under a 0700 directory.
export function writePromotionRecord(input: PromotionRecordInput): PromotionRecord {
  const area = planArea(input.project, input.jobId)
  const at = new Date().toISOString()
  const manifestPath = join(area, "artifacts", input.taskId, "manifest.json")
  const findingsPath = join(area, "findings", `${input.taskId}.md`)
  const patchPath = input.git ? join(area, "patches", `${input.taskId}.patch`) : undefined
  const body = `${input.report}${input.report.endsWith("\n") ? "" : "\n"}`
  const findings = `# ${input.taskId} — ${input.title}\n\nRecorded ${at} for plan job ${input.jobId}.\n\n## Findings\n\n${body}`
  mkdirSync(dirname(findingsPath), { recursive: true, mode: 0o700 })
  writeFileSync(findingsPath, findings, { mode: 0o600 })
  if (patchPath && input.git) {
    mkdirSync(dirname(patchPath), { recursive: true, mode: 0o700 })
    // Written even when empty: the record says the task changed nothing, which is a fact about the plan.
    writeFileSync(patchPath, input.git.patch, { mode: 0o600 })
  }
  const manifest = {
    version: 1,
    job: input.jobId,
    task: input.taskId,
    title: input.title,
    at,
    checks: [...input.checks],
    git: input.git ? { base: input.git.base, head: input.git.head } : null,
    patch: input.git ? `patches/${input.taskId}.patch` : null,
    ...(input.git ? { patchBytes: Buffer.byteLength(input.git.patch) } : {}),
    findings: `findings/${input.taskId}.md`,
    artifacts: input.promotion.promoted.map((a) => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 })),
    rejected: input.promotion.rejected.map((r) => ({ path: r.path, reason: r.reason })),
    ...(input.git ? {} : { note: "no git in this project: there is no patch" }),
  }
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { manifest: manifestPath, findings: findingsPath, ...(patchPath ? { patch: patchPath } : {}) }
}

// The `Artifacts:` lines of a report, comma-separated, with the backticks a model likes around paths. Several lines add
// up; "none" is the report saying it has none, not a file of that name.
export function parseArtifacts(text: string): string[] {
  const paths: string[] = []
  for (const line of text.matchAll(/^[ \t]*Artifacts[ \t]*:[ \t]*(.*)$/gim)) {
    for (const part of line[1]!.split(",")) {
      const path = strip(part.replace(/^[ \t`]+|[ \t`]+$/g, ""))
      if (path && !/^(?:none|\(none\)|-+)$/i.test(path)) paths.push(path)
    }
  }
  return paths
}
