// Staging (B5) brings a job's inputs from outside into it, because every adapter may read only inside the job and a real
// render's model files live in a model directory. These tests fix what it promises: a clone where btrfs offers one, a
// capped copy where it does not, a hash taken from the staged bytes, and refusals that leave nothing behind.
//
// The clone test runs where the machine's TMPDIR is a clone-capable filesystem. `npm test` sets it to a btrfs directory;
// on a filesystem that cannot clone there is no clone to assert, so that test skips and says why instead of pretending a
// copy is one. The copy tests need a source on another device, which is what `/dev/shm` and `/tmp` are for; the helper
// below says so and skips when this machine has no second filesystem.

import assert from "node:assert/strict"
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { sha256File } from "../packages/artifact/src/provenance.ts"
import { stageFile, stageIntoJob } from "../packages/artifact/src/stage.ts"

const written = (path: string, size: number, fill: number): string => {
  writeFileSync(path, Buffer.alloc(size, fill))
  return path
}

// Whether this directory's filesystem can clone at all. It asks the filesystem, not this package, so a filesystem that
// can clone and a stage that answered "copy" still fail the test below.
function canClone(dir: string): boolean {
  const source = join(dir, "clone-probe-source")
  const dest = join(dir, "clone-probe-dest")
  writeFileSync(source, "probe")
  try {
    copyFileSync(source, dest, constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  } finally {
    rmSync(source, { force: true })
    rmSync(dest, { force: true })
  }
}

// A scratch directory on a different device from `near`, so a stage from it cannot clone and has to take the copy path.
// `/dev/shm`, `/tmp` and `/run` are tmpfs on a desktop Linux; a machine whose only filesystem is the one under test has
// no such source, and the caller skips with that sentence rather than inventing a copy.
function foreignScratch(near: string): string | undefined {
  let device: number
  try {
    device = statSync(near).dev
  } catch {
    device = statSync(tmpdir()).dev
  }
  for (const candidate of ["/dev/shm", "/tmp", "/run"]) {
    try {
      if (statSync(candidate).dev === device) continue
      return mkdtempSync(join(candidate, "mm-stage-from-"))
    } catch {
      // Not there, or not writable: try the next one.
    }
  }
  return undefined
}

test("a clone is a clone: the staged model is an independent file, not the one it came from", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-clone-"))
  try {
    if (!canClone(dir)) {
      t.skip(`${dir} cannot clone, so there is no clone for this test to assert; run with TMPDIR on a clone-capable filesystem`)
      return
    }
    const source = written(join(dir, "z_image_turbo_int8.safetensors"), 512 * 1024, 0x5a)
    const job = join(dir, "job")

    const result = await stageFile({ from: source, to: "diffusion_models/z_image_turbo_int8.safetensors" }, { jobDir: job })
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.how, "clone")
    assert.equal(result.path, "diffusion_models/z_image_turbo_int8.safetensors")
    assert.equal(result.bytes, 512 * 1024)
    assert.equal(result.sha256, await sha256File(source))

    const dest = join(job, result.path)
    assert.equal(statSync(dest).mode & 0o777, 0o600, "the staged file is private")
    assert.equal(statSync(join(job, "diffusion_models")).mode & 0o777, 0o700, "the directory it was staged into is private")

    // The point of a clone over a hard link: the job may write its copy and the model must not move.
    writeFileSync(dest, Buffer.alloc(512 * 1024, 0x11))
    assert.equal(readFileSync(source).every((byte) => byte === 0x5a), true, "a write to the staged file reached the source")
    assert.notEqual(result.sha256, await sha256File(dest))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a source on another device cannot clone, so the stage copies it and the copy is its own inode", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-copy-"))
  const foreign = foreignScratch(dir)
  try {
    if (foreign === undefined) {
      t.skip("this machine has no second filesystem to stage from, so a clone cannot be forced to fail; allowCopy cannot force it either")
      return
    }
    const source = written(join(foreign, "qwen_3_4b.safetensors"), 64 * 1024, 0x33)
    const job = join(dir, "job")

    const result = await stageFile({ from: source, to: "text_encoders/qwen_3_4b.safetensors" }, { jobDir: job })
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.how, "copy")
    assert.equal(result.sha256, await sha256File(source))
    const dest = join(job, result.path)
    // A copy is real bytes on the destination filesystem, not a share: the devices differ, the contents match, and a
    // write to the copy does not touch the file it came from.
    assert.notEqual(statSync(dest).dev, statSync(source).dev)
    assert.equal(readFileSync(dest).equals(readFileSync(source)), true)
    writeFileSync(dest, Buffer.alloc(64 * 1024, 0x44))
    assert.equal(readFileSync(source).every((byte) => byte === 0x33), true, "a write to the copy reached the source")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (foreign !== undefined) rmSync(foreign, { recursive: true, force: true })
  }
})

test("a real copy over maxCopyBytes is refused with the size, the cap and allowCopy, and allowed when the caller says so", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-cap-"))
  const foreign = foreignScratch(dir)
  try {
    if (foreign === undefined) {
      t.skip("this machine has no second filesystem, so there is no real copy for the cap to refuse")
      return
    }
    const source = written(join(foreign, "qwen_3_4b.safetensors"), 2 * 1024 * 1024, 0x47)
    const job = join(dir, "job")

    // A clone costs no space, so the cap does not apply to it: the same size, still under a cap of one byte, clones.
    if (canClone(dir)) {
      const local = written(join(dir, "local_encoder.safetensors"), 2 * 1024 * 1024, 0x48)
      const cloned = await stageFile({ from: local, to: "clone/local_encoder.safetensors" }, { jobDir: join(dir, "job-clone"), maxCopyBytes: 1 })
      assert.equal(cloned.ok, true)
      if (cloned.ok) assert.equal(cloned.how, "clone")
    }

    const refused = await stageFile({ from: source, to: "text_encoders/qwen_3_4b.safetensors" }, { jobDir: job, maxCopyBytes: 1 })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.match(refused.refused, /2097152 bytes/)
      assert.match(refused.refused, /1 byte/)
      assert.match(refused.refused, /allowCopy/)
    }
    assert.equal(existsSync(join(job, "text_encoders/qwen_3_4b.safetensors")), false, "a refusal leaves no destination behind")

    const allowed = await stageFile(
      { from: source, to: "text_encoders/qwen_3_4b.safetensors" },
      { jobDir: job, maxCopyBytes: 1, allowCopy: true },
    )
    assert.equal(allowed.ok, true)
    if (!allowed.ok) return
    assert.equal(allowed.how, "copy")
    assert.equal(allowed.bytes, 2 * 1024 * 1024)
    assert.equal(allowed.sha256, await sha256File(source))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (foreign !== undefined) rmSync(foreign, { recursive: true, force: true })
  }
})

test("a declared hash that disagrees with the staged bytes is refused with both hashes and leaves no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-hash-"))
  try {
    const source = written(join(dir, "ae.safetensors"), 4096, 0x21)
    const declared = "0".repeat(64)
    const result = await stageFile({ from: source, to: "vae/ae.safetensors" }, { jobDir: join(dir, "job"), sha256: declared })

    assert.equal(result.ok, false)
    if (!result.ok) {
      const actual = await sha256File(source)
      assert.ok(result.refused.includes(declared), `the refusal names the declared hash: ${result.refused}`)
      assert.ok(result.refused.includes(actual), `the refusal names the staged hash: ${result.refused}`)
    }
    assert.equal(existsSync(join(dir, "job/vae/ae.safetensors")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a destination that climbs out of the job or is absolute is refused, and nothing lands outside", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-to-"))
  try {
    const source = written(join(dir, "model.safetensors"), 128, 0x09)
    const job = join(dir, "job")

    const climbing = await stageFile({ from: source, to: "../outside" }, { jobDir: job })
    assert.equal(climbing.ok, false)
    if (!climbing.ok) assert.match(climbing.refused, /resolves outside the job directory/)
    assert.equal(existsSync(join(dir, "outside")), false, "nothing was written beside the job")

    const absolute = await stageFile({ from: source, to: join(job, "model.safetensors") }, { jobDir: job })
    assert.equal(absolute.ok, false)
    if (!absolute.ok) assert.match(absolute.refused, /is absolute/)
    assert.equal(existsSync(join(job, "model.safetensors")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a directory is refused by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-dir-"))
  try {
    const source = join(dir, "a-model-directory")
    mkdirSync(source)
    const job = join(dir, "job")

    const result = await stageFile({ from: source, to: "model" }, { jobDir: job })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.refused, /is a directory/)
    assert.equal(existsSync(join(job, "model")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("stageIntoJob stages the files it can, refuses the one it cannot, and reports both", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-many-"))
  try {
    const root = join(dir, "split_files")
    mkdirSync(root)
    written(join(root, "a.safetensors"), 1024, 0x0a)
    written(join(root, "b.safetensors"), 2048, 0x0b)
    const job = join(dir, "job")

    // The missing file sits between the two good ones, so a loop that stopped at the first refusal would lose `b`.
    const { staged, refused } = await stageIntoJob({
      root,
      jobDir: job,
      files: ["a.safetensors", "missing.safetensors", "b.safetensors"],
    })

    assert.equal(staged.length, 2)
    assert.equal(refused.length, 1)
    assert.deepEqual(
      staged.map((result) => (result.ok ? result.path : undefined)),
      ["a.safetensors", "b.safetensors"],
    )
    const first = refused[0]!
    assert.equal(first.ok, false)
    if (!first.ok) assert.match(first.refused, /missing\.safetensors.*cannot be read/)
    assert.equal(existsSync(join(job, "a.safetensors")), true)
    assert.equal(existsSync(join(job, "b.safetensors")), true)
    assert.equal(existsSync(join(job, "missing.safetensors")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the manifest entry says the file is an input and carries the staged bytes and hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-stage-manifest-"))
  try {
    const source = written(join(dir, "ae.safetensors"), 300_000, 0x3c)
    const job = join(dir, "job")
    const expected = await sha256File(source)

    const result = await stageFile({ from: source, to: "vae/ae.safetensors" }, { jobDir: job, sha256: expected })
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.deepEqual(result.manifest, { path: "vae/ae.safetensors", bytes: 300_000, sha256: expected, source: "input" })
    assert.equal(result.bytes, result.manifest.bytes)
    assert.equal(result.sha256, result.manifest.sha256)
    assert.equal(statSync(join(job, "vae/ae.safetensors")).size, 300_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
