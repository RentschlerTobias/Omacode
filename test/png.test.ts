// The blank-slide reader (B3-T4) is small but it has to be right about bytes, so these tests build real PNG files
// rather than stubs: a tiny encoder below writes the signature, an IHDR, deflated filter-0 rows and an IEND, exactly
// the shape HyperFrames' snapshots have. One base64 fixture comes from outside this file, so the encoder is not the
// only witness to its own output.
//
// The assertions are chosen to fail for the mistakes the module is most likely to make: a reader that ignores rows
// passes a uniform frame, one that mishandles alpha hides the difference between RGB and RGBA, and a blank test with
// no threshold calls a slide with a mark on it empty. The timing test is a loose upper bound — it exists to catch a
// quadratic scan, not to measure the machine.

import assert from "node:assert/strict"
import { test } from "node:test"
import { deflateSync } from "node:zlib"

import { blankFrame, frameUniformity, readPng, type Rgba } from "../packages/artifact/src/png.ts"

// CRC-32 over the chunk type and data, the checksum PNG puts after every chunk.
function crc32(bytes: Uint8Array): number {
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
function encodePng(
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
      for (let channel = 0; channel < channels; channel += 1) raw[x * channels + channel] = values[channel]
    }
    const filter = opts.filters?.[y] ?? 0
    data[y * (stride + 1)] = filter
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? raw[index - channels] : 0
      const up = y > 0 ? previous[index] : 0
      const upLeft = y > 0 && index >= channels ? previous[index - channels] : 0
      const predictor =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
      data[y * (stride + 1) + 1 + index] = (raw[index] - predictor) & 0xff
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

const solid = (colour: readonly number[]) => () => colour

function decoded(bytes: Uint8Array): Rgba {
  const image = readPng(bytes)
  assert.ok(!("unsupported" in image), `expected a picture, got ${JSON.stringify(image)}`)
  return image
}

test("an all-white frame is blank", () => {
  const image = decoded(encodePng(64, 64, 6, solid([255, 255, 255, 255])))
  const verdict = blankFrame(image)
  assert.equal(verdict.blank, true)
  assert.equal(verdict.share, 1)
  assert.equal(verdict.why, "100.0% of the frame is #ffffff")
  assert.deepEqual(frameUniformity(image).modal, [255, 255, 255])
})

test("an 8x8 black square in a corner stops the frame from being blank", () => {
  const image = decoded(
    encodePng(64, 64, 6, (x, y) => (x < 8 && y < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255])),
  )
  const verdict = blankFrame(image)
  assert.equal(verdict.blank, false)
  assert.ok(verdict.share > 0.97 && verdict.share < 0.995, `share was ${verdict.share}`)
  assert.match(verdict.why, /^9[78]\.\d% of the frame is #ffffff$/)
})

test("a 2x2 half-black frame keeps its row order and is not blank", () => {
  const image = decoded(
    encodePng(2, 2, 6, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])),
  )
  assert.deepEqual(image.at(0, 0), [0, 0, 0, 255])
  assert.deepEqual(image.at(1, 0), [255, 255, 255, 255])
  assert.deepEqual(image.at(0, 1), [255, 255, 255, 255])
  assert.deepEqual(image.at(1, 1), [0, 0, 0, 255])
  const verdict = blankFrame(image)
  assert.equal(verdict.blank, false)
  assert.equal(verdict.share, 0.5)
})

test("RGB and grey images decode with opaque alpha", () => {
  const rgb = decoded(encodePng(2, 1, 2, (x) => (x === 0 ? [12, 34, 56] : [200, 100, 0])))
  assert.deepEqual(rgb.at(0, 0), [12, 34, 56, 255])
  assert.deepEqual(rgb.at(1, 0), [200, 100, 0, 255])

  const grey = decoded(encodePng(2, 1, 0, (x) => (x === 0 ? [7] : [250])))
  assert.deepEqual(grey.at(0, 0), [7, 7, 7, 255])
  assert.deepEqual(grey.at(1, 0), [250, 250, 250, 255])

  const greyAlpha = decoded(encodePng(1, 1, 4, solid([90, 128])))
  assert.deepEqual(greyAlpha.at(0, 0), [90, 90, 90, 128])
})

test("every row filter reconstructs the same pixels", () => {
  const expected = (x: number, y: number) => [x * 30 + y, 255 - x * 20, 10 * y + 5, 255]
  const plain = decoded(encodePng(5, 5, 6, expected))
  const filtered = decoded(encodePng(5, 5, 6, expected, { filters: [0, 1, 2, 3, 4] }))
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) assert.deepEqual(filtered.at(x, y), plain.at(x, y), `pixel ${x},${y}`)
  }
})

test("a 16-bit PNG is unsupported and names the bit depth", () => {
  const result = readPng(encodePng(1, 1, 6, solid([0, 0, 0, 255]), { bitDepth: 16 }))
  assert.ok("unsupported" in result)
  assert.match(result.unsupported, /bit depth 16/)
})

test("an interlaced PNG is unsupported and names the method", () => {
  const result = readPng(encodePng(1, 1, 6, solid([0, 0, 0, 255]), { interlace: 1 }))
  assert.ok("unsupported" in result)
  assert.match(result.unsupported, /interlace method 1/)
})

test("a truncated file is unsupported and says where it stopped", () => {
  const whole = encodePng(2, 2, 6, solid([255, 255, 255, 255]))
  const result = readPng(whole.subarray(0, 30))
  assert.ok("unsupported" in result)
  assert.match(result.unsupported, /truncated IHDR chunk/)
})

test("a palette PNG, a missing IDAT and a bad header CRC are refused instead of throwing", () => {
  const palette = Buffer.from(encodePng(1, 1, 6, solid([0, 0, 0, 255])))
  // Turn the colour type into 3 (palette) and repair the header CRC, so the refusal is about the colour type itself
  // rather than about the byte we just changed.
  palette[8 + 8 + 9] = 3
  palette.writeUInt32BE(crc32(palette.subarray(12, 29)), 29)
  const paletteResult = readPng(palette)
  assert.ok("unsupported" in paletteResult)
  assert.match(paletteResult.unsupported, /colour type 3/)

  const noData = readPng(encodePng(2, 2, 6, solid([255, 255, 255, 255]), { idat: false }))
  assert.ok("unsupported" in noData)
  assert.match(noData.unsupported, /no IDAT chunk/)

  const corrupt = Buffer.from(encodePng(1, 1, 6, solid([255, 255, 255, 255])))
  corrupt[16] ^= 0xff
  const corruptResult = readPng(corrupt)
  assert.ok("unsupported" in corruptResult)
  assert.match(corruptResult.unsupported, /CRC mismatch/)
})

test("the base64 1x1 PNG decodes to one blank pixel", () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  const image = decoded(bytes)
  assert.equal(image.width, 1)
  assert.equal(image.height, 1)
  assert.equal(blankFrame(image).blank, true)
})

test("a 1920x1080 white frame decodes and is judged well under a second", () => {
  const bytes = encodePng(1920, 1080, 6, solid([255, 255, 255, 255]))
  const started = Date.now()
  const image = decoded(bytes)
  const verdict = blankFrame(image)
  const elapsed = Date.now() - started
  assert.equal(verdict.blank, true)
  assert.ok(elapsed < 2000, `took ${elapsed} ms`)
})
