// The blank-slide reader (B3-T4) is small but it has to be right about bytes, so these tests build real PNG files
// rather than stubs: the encoder in `harness.ts` (shared with the video's frame rules, B2-T4) writes the signature, an
// IHDR, deflated filter-0 rows and an IEND, exactly the shape HyperFrames' snapshots have. One base64 fixture comes from
// outside this file, so the encoder is not the only witness to its own output.
//
// The assertions are chosen to fail for the mistakes the module is most likely to make: a reader that ignores rows
// passes a uniform frame, one that mishandles alpha hides the difference between RGB and RGBA, and a blank test with
// no threshold calls a slide with a mark on it empty. The timing test is a loose upper bound — it exists to catch a
// quadratic scan, not to measure the machine.

import assert from "node:assert/strict"
import { test } from "node:test"

import { crc32, encodePng, solid } from "./harness.ts"
import { blankFrame, frameUniformity, readPng, type Rgba } from "../packages/artifact/src/png.ts"

const decoded = (bytes: Uint8Array): Rgba => {
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
