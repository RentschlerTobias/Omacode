// Staging: the step that brings a job's inputs from outside into it. Every adapter may read and write only inside the job
// (the image adapter refuses an absolute path, a ".." and a symlink out), and a real render needs files that live
// elsewhere: a 6 GB diffusion model, a 5 GB text encoder and a VAE under a model directory. This module is how those
// bytes arrive, and why the arrival is safe to repeat.
//
// A clone is the shape this wants. `/home` is btrfs, where `copyFile` with COPYFILE_FICLONE_FORCE shares the extents and
// copies nothing: instant, no extra space, and the result is an independent file, because a write to either side breaks
// the share. A hard link would be cheaper still and wrong: a job that truncated its copy would truncate the model, and a
// job cleaned up with `rm -rf` would take one link off a file someone else still needs.
//
// Where the filesystem cannot clone — tmpfs, ext4, a different device, an unsupported kernel — the fallback is a real
// copy, and a real copy of a model is not something to do quietly. `maxCopyBytes` caps it at 1 GiB and `allowCopy` is the
// caller saying it knows the size; past the cap the answer is a refusal that names the bytes, the cap and the permission.
//
// The destination is hashed, not the source: the manifest has to describe the bytes that actually landed in the job, and
// a hash taken before a copy is a claim about a different file. A declared hash that disagrees is refused with both
// values, because one of the two is wrong and neither can be preferred without saying so.
//
// Every failure is a value. A refusal leaves no destination behind and no partial file for a later step to load; the
// parent is created 0700 and the file ends 0600, like the rest of the job's files.

import { chmodSync, constants, copyFileSync, mkdirSync, rmSync, statSync, type Stats } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

import { insidePath, realish } from "./paths.ts"
import { sha256File, type ManifestEntry } from "./provenance.ts"

// A clone costs no space, so the cap is about the copy that replaces it. 1 GiB is larger than a VAE and smaller than any
// diffusion model or text encoder worth the name: the files that fit can be copied without asking, the ones that do not
// need `allowCopy`.
const DEFAULT_MAX_COPY_BYTES = 1024 * 1024 * 1024

// A filesystem says "not here" in one of these ways. All four mean the same thing to this module: no clone is possible
// at the destination, so the fallback decides. Any other error is a refusal and not a fallback — a permission denied is
// not a filesystem that cannot clone.
const CLONE_IMPOSSIBLE: ReadonlySet<string> = new Set(["EOPNOTSUPP", "ENOTSUP", "EXDEV", "EINVAL"])

export interface StageRequest {
  readonly from: string
  // Job-relative, like every path an adapter may read. An absolute path or one that leaves the job is a refusal.
  readonly to: string
}

export interface StageOptions {
  readonly jobDir: string
  // What the caller believes the file is. Checked against the staged copy's bytes, which win.
  readonly sha256?: string
  readonly maxCopyBytes?: number
  readonly allowCopy?: boolean
}

export type StageResult =
  | {
      readonly ok: true
      readonly path: string
      readonly bytes: number
      readonly sha256: string
      readonly how: "clone" | "copy"
      readonly manifest: ManifestEntry
    }
  | { readonly ok: false; readonly refused: string }

const shown = (value: string): string => JSON.stringify(value)
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined

// What a path is, when it is not a regular file. Naming the kind is the point: "a directory" tells a caller which
// argument is wrong, where "not a file" sends them looking at permissions.
function notRegular(info: Stats): string | undefined {
  if (info.isFile()) return undefined
  if (info.isDirectory()) return "a directory"
  if (info.isBlockDevice() || info.isCharacterDevice()) return "a device"
  if (info.isFIFO()) return "a fifo"
  if (info.isSocket()) return "a socket"
  return "an unsupported kind of entry"
}

// The destination, or why there cannot be one. Checked before the source is read, so a path that leaves the job is
// refused without touching anything outside it. `realish` rather than `resolve` because the parent usually does not
// exist yet, and a symlinked parent inside the job that points out is the case a lexical check cannot see.
function destination(to: string, jobDir: string): { readonly path: string; readonly root: string } | { readonly refused: string } {
  if (!to) return { refused: "a staged file needs a job-relative path, and this request named none" }
  if (isAbsolute(to)) return { refused: `${shown(to)} is absolute, but a job path is relative to the job directory` }
  if (to.endsWith("/")) return { refused: `${shown(to)} names a directory, not a file` }
  const root = realish(jobDir)
  const path = realish(join(root, to))
  if (path === root) return { refused: `${shown(to)} names the job directory, not a file` }
  if (!insidePath(root, path)) return { refused: `${shown(to)} resolves outside the job directory (${path})` }
  return { path, root }
}

// A refusal is a value, and the destination of a refusal is not a file the job may read later.
function discard(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A file that cannot be removed is still not a staged file: the caller holds the refusal, not a path.
  }
}

export async function stageFile(request: StageRequest, options: StageOptions): Promise<StageResult> {
  const dest = destination(request.to, options.jobDir)
  if ("refused" in dest) return { ok: false, refused: dest.refused }

  // A symlink is resolved to what it points at, so a link to a model is staged as the model and a link to a directory
  // is refused as that directory. `realish` answers for a path that does not exist too, and the stat below is what
  // decides whether there is anything to stage.
  const from = realish(request.from)
  let source: Stats
  try {
    source = statSync(from)
  } catch (error) {
    return { ok: false, refused: `${shown(request.from)} cannot be read (${reason(error)})` }
  }
  const kind = notRegular(source)
  if (kind !== undefined) {
    return { ok: false, refused: `${shown(request.from)} is ${kind}; a staged input must be a regular file` }
  }

  mkdirSync(dirname(dest.path), { recursive: true, mode: 0o700 })

  let how: "clone" | "copy"
  try {
    copyFileSync(from, dest.path, constants.COPYFILE_FICLONE_FORCE)
    how = "clone"
  } catch (error) {
    const code = errorCode(error)
    if (code === undefined || !CLONE_IMPOSSIBLE.has(code)) {
      discard(dest.path)
      return { ok: false, refused: `${shown(request.to)}: cannot be copied (${reason(error)})` }
    }
    // A forced clone that failed has written nothing useful; remove whatever it may have created before the fallback.
    discard(dest.path)
    const cap = options.maxCopyBytes ?? DEFAULT_MAX_COPY_BYTES
    if (!(source.size <= cap || options.allowCopy === true)) {
      return {
        ok: false,
        refused:
          `${shown(request.from)} is ${source.size} bytes, and this filesystem cannot clone it; the copy cap is ` +
          `${cap} byte${cap === 1 ? "" : "s"}, so staging it needs allowCopy`,
      }
    }
    try {
      copyFileSync(from, dest.path)
    } catch (error) {
      discard(dest.path)
      return { ok: false, refused: `${shown(request.to)}: cannot be copied (${reason(error)})` }
    }
    how = "copy"
  }

  try {
    chmodSync(dest.path, 0o600)
  } catch (error) {
    discard(dest.path)
    return { ok: false, refused: `${shown(request.to)}: cannot be made private (${reason(error)})` }
  }

  // The staged bytes are the fact the manifest and the caller both carry. A size read here rather than from the source
  // means a clone and a copy describe the file that is actually in the job.
  let bytes: number
  try {
    bytes = statSync(dest.path).size
  } catch (error) {
    discard(dest.path)
    return { ok: false, refused: `${shown(request.to)}: cannot be measured (${reason(error)})` }
  }
  let sha256: string
  try {
    sha256 = await sha256File(dest.path)
  } catch (error) {
    discard(dest.path)
    return { ok: false, refused: `${shown(request.to)}: cannot be hashed (${reason(error)})` }
  }
  if (options.sha256 !== undefined && options.sha256 !== sha256) {
    discard(dest.path)
    return {
      ok: false,
      refused: `${shown(request.to)}: declared sha256 ${options.sha256}, but the staged copy hashes to ${sha256}`,
    }
  }

  const path = relative(dest.root, dest.path).split(sep).join("/")
  return { ok: true, path, bytes, sha256, how, manifest: { path, bytes, sha256, source: "input" } }
}

// Stage a batch named relative to a root outside the job. One file at a time, and a refusal does not stop the rest: a
// job that needs three files should hear about the two that arrived and the one that did not, in one answer.
export async function stageIntoJob(input: {
  readonly root: string
  readonly jobDir: string
  readonly files: readonly string[]
  readonly sha256?: Readonly<Record<string, string>>
  readonly maxCopyBytes?: number
  readonly allowCopy?: boolean
}): Promise<{ readonly staged: readonly StageResult[]; readonly refused: readonly StageResult[] }> {
  const staged: StageResult[] = []
  const refused: StageResult[] = []
  for (const rel of input.files) {
    const declared = input.sha256?.[rel]
    const result = await stageFile(
      { from: join(input.root, rel), to: rel },
      {
        jobDir: input.jobDir,
        ...(declared !== undefined ? { sha256: declared } : {}),
        ...(input.maxCopyBytes !== undefined ? { maxCopyBytes: input.maxCopyBytes } : {}),
        ...(input.allowCopy !== undefined ? { allowCopy: input.allowCopy } : {}),
      },
    )
    if (result.ok) staged.push(result)
    else refused.push(result)
  }
  return { staged, refused }
}
