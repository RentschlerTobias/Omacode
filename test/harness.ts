// Shared test helpers. Kept out of node:test so every test file can import them.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"

import { readPng, type Rgba } from "../packages/artifact/src/png.ts"

// os.tmpdir() follows TMPDIR, which the sandbox gives each worker. When that
// directory is not writable (a read-only /tmp, a full one, a permission wall)
// fall back to another writable place outside the repository.
function scratch(): string {
  const candidates = [process.env.MICROMANAGER_TEST_TMPDIR, "/dev/shm"]
  for (const dir of candidates) {
    if (!dir) continue
    try {
      return mkdtempSync(join(dir, "mm-test-"))
    } catch {
      // try the next candidate
    }
  }
  return mkdtempSync(join(tmpdir(), "mm-test-"))
}

export function tempDir(prefix = "mm-"): string {
  try {
    return mkdtempSync(join(tmpdir(), prefix))
  } catch {
    return scratch()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// A real PNG encoder. The deck's blank check (B3-T4) and the video's frame rules (B2-T4) are about bytes, so their tests
// build actual PNG files rather than stubs: the signature, an IHDR, deflated filter-0 rows and an IEND, exactly the shape
// HyperFrames' snapshots and ffmpeg's frames have. The helpers live here because two test files now need them.

// CRC-32 over the chunk type and data, the checksum PNG puts after every chunk.
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

type Channels = 1 | 2 | 3 | 4
const CHANNELS: Readonly<Record<number, Channels>> = { 0: 1, 2: 3, 4: 2, 6: 4 }

// A real PNG, filter 0 by default and any of the five filters on demand. The forward filter uses the same
// reconstructed bytes the reader is meant to undo, so a test that round-trips is testing the reader and not the
// encoder's arithmetic.
export function encodePng(
  width: number,
  height: number,
  colourType: 0 | 2 | 4 | 6,
  pixel: (x: number, y: number) => readonly number[],
  opts: { readonly bitDepth?: number; readonly interlace?: number; readonly filters?: readonly number[]; readonly idat?: boolean } = {},
): Buffer {
  const channels = CHANNELS[colourType]
  const stride = width * channels
  const data = Buffer.alloc(height * (stride + 1))
  let previous = new Uint8Array(stride)
  const paeth = (left: number, up: number, upLeft: number): number => {
    const p = left + up - upLeft
    const pa = Math.abs(p - left)
    const pb = Math.abs(p - up)
    const pc = Math.abs(p - upLeft)
    return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
  }
  for (let y = 0; y < height; y += 1) {
    const raw = new Uint8Array(stride)
    for (let x = 0; x < width; x += 1) {
      const values = pixel(x, y)
      for (let channel = 0; channel < channels; channel += 1) raw[x * channels + channel] = values[channel]!
    }
    const filter = opts.filters?.[y] ?? 0
    data[y * (stride + 1)] = filter
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? raw[index - channels]! : 0
      const up = y > 0 ? previous[index]! : 0
      const upLeft = y > 0 && index >= channels ? previous[index - channels]! : 0
      const predictor =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
      data[y * (stride + 1) + 1 + index] = (raw[index]! - predictor) & 0xff
    }
    previous = raw
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = opts.bitDepth ?? 8
  header[9] = colourType
  header[10] = 0
  header[11] = 0
  header[12] = opts.interlace ?? 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(opts.idat === false ? [] : [chunk("IDAT", deflateSync(data))]),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export const solid = (colour: readonly number[]) => () => colour

// A frame as the PNG reader and the QA rules see it. `encodePng` is the only encoder, so a test's picture is a real file's
// picture and not an object this helper invented.
export function frame(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): Rgba {
  const image = readPng(encodePng(width, height, 6, pixel))
  if ("unsupported" in image) throw new Error(`the test's PNG must decode: ${image.unsupported}`)
  return image
}
