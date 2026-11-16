// A minimal PNG reader for the deck's blank-slide check (B3-T4). HyperFrames writes PNG snapshots and says nothing
// about whether one is empty, so the check has to look at the pixels itself. The project has no image dependency and
// does not want one for a question this small, so this file reads exactly the PNGs HyperFrames writes — 8-bit,
// non-interlaced, the four non-palette colour types — and refuses everything else with a reason instead of guessing.
//
// It is a reader for our own snapshots, not a general PNG library: no palette, no 16-bit samples, no Adam7, no
// text/metadata chunks, no incremental decoding. Anything outside the supported shape comes back as
// `{ unsupported }` and never as a throw, because a caller that has to catch an exception to find out whether a
// picture can be read has no way to tell "this file is odd" from "this code is broken". The caller must treat
// `unsupported` as "the check is skipped with this reason", not as "the frame is blank".
//
// The only import is `node:zlib`. The module takes bytes and returns pixels; it never opens a file, so the caller
// decides what is worth reading.

import { inflateSync } from "node:zlib"

// A decoded frame, addressed in image coordinates with the origin at the top left, the same order PNG stores its
// scanlines. `at` returns a fresh tuple per call and never needs a second lookup table, so a caller that wants one
// pixel does not pay for the whole frame twice.
export interface Rgba {
  readonly width: number
  readonly height: number
  readonly at: (x: number, y: number) => readonly [number, number, number, number]
}

// The other answer: a PNG this reader will not read, described by what it is rather than by what failed. It is a
// value and not an error, so a caller can put it in a result without a try block.
export interface PngProblem {
  readonly unsupported: string
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const HEADER_BYTES = 13

// CRC-32 as PNG defines it: the standard reflected polynomial, computed over the chunk type and its data. Only the
// header is checked here — a wrong CRC on a pixel chunk would be a corrupted picture, and the decompressor and the
// expected byte count already catch that far more directly than a checksum whose value a caller cannot act on. The
// header is the one chunk read before anything else can be trusted, so a mismatch there is refused rather than risk
// reading a width and colour type that the file did not mean.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Channels per pixel for the colour types this reader accepts. The value is used to size a scanline and to decide
// what `at` reports for the channels the format does not carry.
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }

function unsupported(reason: string): PngProblem {
  return { unsupported: reason }
}

interface Chunk {
  readonly type: string
  readonly data: Uint8Array
}

// The chunk walk, up to the first IDAT run. PNG allows a chunk to end with IEND, and it forbids anything between the
// IDATs, so stopping at the first non-IDAT chunk after the image data started is the whole file's contract, not a
// shortcut. A chunk whose declared length runs past the end is a truncated file and is reported as such.
function chunksOf(bytes: Uint8Array): readonly Chunk[] | PngProblem {
  const chunks: Chunk[] = []
  let offset = SIGNATURE.length
  let dataSeen = false
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
    const length = view.getUint32(0)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) {
      return unsupported(`truncated ${type} chunk: ${length} bytes declared, ${bytes.length - start} left in the file`)
    }
    const data = bytes.subarray(start, end)
    const stored = new DataView(bytes.buffer, bytes.byteOffset + end, 4).getUint32(0)
    if (type === "IHDR" && stored !== crc32(bytes.subarray(offset + 4, end))) {
      return unsupported("IHDR CRC mismatch: the header does not match its checksum")
    }
    if (type === "IDAT") dataSeen = true
    else if (dataSeen) break
    chunks.push({ type, data })
    offset = end + 4
    if (type === "IEND") break
  }
  return chunks
}

// Undo the five PNG row filters in place. The first row of each pass has no row above it, which PNG spells as a
// previous row of zeroes; Average and Paeth therefore see `up = 0` there. The arithmetic is byte-wise modulo 256,
// and Paeth's predictor is the standard one — the nearest of left, above and above-left.
function unfilter(filtered: Uint8Array, stride: number, bytesPerPixel: number): Uint8Array | PngProblem {
  const rows = filtered.length / (stride + 1)
  if (!Number.isInteger(rows)) {
    return unsupported(`filtered image data is ${filtered.length} bytes, which does not split into ${stride + 1}-byte rows`)
  }
  const out = new Uint8Array(rows * stride)
  for (let y = 0; y < rows; y += 1) {
    const filter = filtered[y * (stride + 1)]
    const source = y * (stride + 1) + 1
    const target = y * stride
    const above = target - stride
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[source + x]
      const left = x >= bytesPerPixel ? out[target + x - bytesPerPixel] : 0
      const up = y > 0 ? out[above + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? out[above + x - bytesPerPixel] : 0
      let value: number
      switch (filter) {
        case 0:
          value = raw
          break
        case 1:
          value = raw + left
          break
        case 2:
          value = raw + up
          break
        case 3:
          value = raw + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default:
          return unsupported(`unknown row filter ${filter} on row ${y}`)
      }
      out[target + x] = value & 0xff
    }
  }
  return out
}

// Read one PNG into RGBA. Success is a frame whose alpha is 255 wherever the file carries none (grey and RGB), so a
// blank-slide check never has to know which colour type it was given. Failure is a reason naming the value that put
// the file outside this reader's shape: a bit depth, a colour type, an interlace method, a missing chunk, a corrupt
// header, a truncated tail. No input throws.
export function readPng(bytes: Uint8Array): Rgba | PngProblem {
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) return unsupported("not a PNG: the 8-byte signature does not match")
  }
  const chunks = chunksOf(bytes)
  if ("unsupported" in chunks) return chunks

  const header = chunks.find((chunk) => chunk.type === "IHDR")
  if (header === undefined) return unsupported("no IHDR chunk: the file has no image header")
  if (header.data.length !== HEADER_BYTES) {
    return unsupported(`IHDR is ${header.data.length} bytes, not ${HEADER_BYTES}`)
  }
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength)
  const width = view.getUint32(0)
  const height = view.getUint32(4)
  const bitDepth = header.data[8]
  const colourType = header.data[9]
  const compression = header.data[10]
  const filterMethod = header.data[11]
  const interlace = header.data[12]

  if (width === 0 || height === 0) return unsupported(`image size ${width}x${height} has a zero side`)
  if (bitDepth !== 8) return unsupported(`bit depth ${bitDepth}, not 8`)
  const channels = CHANNELS[colourType]
  if (channels === undefined) {
    return unsupported(
      `colour type ${colourType}, not 0 (grey), 2 (RGB), 4 (grey+alpha) or 6 (RGBA)`,
    )
  }
  if (compression !== 0) return unsupported(`compression method ${compression}, not 0 (deflate)`)
  if (filterMethod !== 0) return unsupported(`filter method ${filterMethod}, not 0`)
  if (interlace !== 0) return unsupported(`interlace method ${interlace} (Adam7), not 0 (none)`)

  const idat = chunks.filter((chunk) => chunk.type === "IDAT")
  if (idat.length === 0) return unsupported("no IDAT chunk: the file carries no image data")

  const compressed = Buffer.concat(idat.map((chunk) => chunk.data))
  let inflated: Buffer
  try {
    inflated = inflateSync(compressed)
  } catch (error) {
    return unsupported(`image data does not inflate: ${error instanceof Error ? error.message : String(error)}`)
  }

  const stride = width * channels
  const expected = height * (stride + 1)
  if (inflated.length !== expected) {
    return unsupported(`inflated image data is ${inflated.length} bytes, not the ${expected} a ${width}x${height} image needs`)
  }
  const pixels = unfilter(inflated, stride, channels)
  if (!(pixels instanceof Uint8Array)) return pixels

  const sample = (x: number, y: number): readonly [number, number, number, number] => {
    const base = y * stride + x * channels
    if (channels === 1) {
      const grey = pixels[base]
      return [grey, grey, grey, 255]
    }
    if (channels === 2) {
      const grey = pixels[base]
      return [grey, grey, grey, pixels[base + 1]]
    }
    if (channels === 3) return [pixels[base], pixels[base + 1], pixels[base + 2], 255]
    return [pixels[base], pixels[base + 1], pixels[base + 2], pixels[base + 3]]
  }

  return { width, height, at: sample }
}

// The most common colour in a frame and how much of the frame it covers. Colours are quantised to 4 bits per channel
// before counting so that a screenshot's dithering or a browser's anti-aliasing does not split one background into
// hundreds of buckets; `modal` is the first actual colour seen in the winning bucket, so the answer is a colour the
// frame really contains rather than a bucket centre. `tolerance` is per channel and absolute, which is why a colour
// one step away from the modal one still counts towards its share.
//
// Sampling is enough because this answers a uniformity question, not a fidelity one: a blank frame is blank
// everywhere, and a frame with content has that content spread over an area far larger than the sample grid. Every
// `step`-th pixel in both directions turns a 1920x1080 frame into ~230k samples instead of ~2M — the same verdict
// for a ninth of the work. A single misplaced pixel would not change the verdict either, and a check that could be
// fooled by one pixel would be a check nobody should trust.
export function frameUniformity(
  image: Rgba,
  opts: { readonly tolerance?: number; readonly step?: number } = {},
): { readonly modal: readonly [number, number, number]; readonly share: number; readonly sampled: number } {
  const tolerance = Math.max(0, opts.tolerance ?? 8)
  // The step is a grid spacing, but it may never be so coarse that the frame is represented by a single corner: with
  // the default 3, a 2x2 image would be judged from (0,0) alone and a half-black picture would look uniform. Capping
  // the spacing at `dimension - 1` guarantees at least two samples along every side that has two pixels.
  const step = Math.max(1, Math.min(Math.floor(opts.step ?? 3), image.width - 1, image.height - 1) || 1)
  const counts = new Map<number, { colour: readonly [number, number, number]; count: number }>()
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const [r, g, b] = image.at(x, y)
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const seen = counts.get(key)
      if (seen === undefined) counts.set(key, { colour: [r, g, b], count: 1 })
      else seen.count += 1
    }
  }

  let modal: readonly [number, number, number] = [0, 0, 0]
  let best = 0
  let sampled = 0
  for (const bucket of counts.values()) {
    sampled += bucket.count
    if (bucket.count > best) {
      best = bucket.count
      modal = bucket.colour
    }
  }
  if (sampled === 0) return { modal, share: 0, sampled: 0 }

  let close = 0
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const [r, g, b] = image.at(x, y)
      if (Math.abs(r - modal[0]) <= tolerance && Math.abs(g - modal[1]) <= tolerance && Math.abs(b - modal[2]) <= tolerance) {
        close += 1
      }
    }
  }
  return { modal, share: close / sampled, sampled }
}

const hex = (value: number): string => value.toString(16).padStart(2, "0")

// The blank-slide verdict. A frame is blank when the share of pixels near one colour reaches `threshold`; the
// default 0.995 leaves room for the noise a screenshot has at its edges but not for a single line of text. Text is
// the case that matters: a headline at normal slide size covers a few percent of a frame, an 8x8 mark on a 64x64
// frame covers 1.5%, and both are far below 99.5%. A truly white 1920x1080 slide differs from that floor only by
// anti-aliasing at its invisible border, so the threshold separates "nothing was rendered" from "something was"
// without ever needing to recognise what the something is.
export function blankFrame(
  image: Rgba,
  opts: { readonly tolerance?: number; readonly threshold?: number } = {},
): { readonly blank: boolean; readonly share: number; readonly why: string } {
  const threshold = opts.threshold ?? 0.995
  const { modal, share } = frameUniformity(image, { tolerance: opts.tolerance })
  const colour = `#${hex(modal[0])}${hex(modal[1])}${hex(modal[2])}`
  return {
    blank: share >= threshold,
    share,
    why: `${(share * 100).toFixed(1)}% of the frame is ${colour}`,
  }
}
