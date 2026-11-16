// The deterministic half of the image checks (B5-T5). A vision model is the only thing that can say whether a picture
// shows the cat a prompt asked for, and no local one is configured — D13/D21 forbid calling a cloud one for a check — so
// that question is declared absent in the registry (`images.vlm`, skippable) rather than guessed at here. What is left
// is what a file can answer about itself, and it is worth answering: whether the prompt the author wrote is the prompt
// the graph was handed, whether the set looks like one set, and whether the licence facts that made the pictures
// possible are still attached to them.
//
// Two rules live here, both functions of pixels and text, so both are testable without a server and neither can drift
// with a model's mood:
//
// - style consistency. Every picture is reduced to a 4×4×4 RGB histogram and two luma numbers, and each slot is compared
//   to the set's own average. A set that was asked for one look and came back with a red frame among blue ones is a set
//   nobody will use, and that is visible without recognising a single object. The comparison is a histogram
//   intersection, which is what "the same colours in the same proportions" means numerically.
// - the prompt checklist. The content words of a slot's prompt ("calm", "gradient", …) have to reach the workflow's
//   positive CLIP text. That is not "the picture shows them" — only the vision review could say that — it is "the server
//   was actually asked", which is the failure that is invisible in a report and obvious in the picture.
//
// Sampling is a fixed grid, the same step for every picture, so the same file always yields the same numbers. Nothing
// here reads the clock, draws a random sample or depends on the order the files were written.

import type { Rgba } from "./png.ts"

// 4 bits per channel: one bucket per 16 levels of red, green and blue. Coarser than the eye and fine enough to tell a
// blue frame from a red one; anti-aliasing and dithering inside a bucket is exactly the noise this must not react to.
const BITS = 4
export const HISTOGRAM_BINS = (1 << BITS) ** 3

// One picture's style, in numbers. `histogram` is normalised to sum to 1, so two pictures of different sizes compare.
export interface ImageStyle {
  readonly histogram: readonly number[]
  readonly luma: number
  readonly contrast: number
  readonly sampled: number
}

// The step the grid walks. Capped by the picture's own size so a 2×2 fixture is judged from more than one pixel.
const stepFor = (image: Rgba, wanted: number): number =>
  Math.max(1, Math.min(wanted, Math.max(1, image.width - 1), Math.max(1, image.height - 1)))

export function styleOf(image: Rgba, opts: { readonly step?: number } = {}): ImageStyle {
  const step = stepFor(image, opts.step ?? 4)
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0)
  let sum = 0
  let sumSquares = 0
  let sampled = 0
  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const [r, g, b] = image.at(x, y)
      const bin = ((r >> BITS) << (BITS * 2)) | ((g >> BITS) << BITS) | (b >> BITS)
      counts[bin] = (counts[bin] ?? 0) + 1
      // Rec. 601 luma: the weights every camera and codec uses for "how bright is this pixel to a person".
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      sum += luma
      sumSquares += luma * luma
      sampled += 1
    }
  }
  if (sampled === 0) return { histogram: counts, luma: 0, contrast: 0, sampled: 0 }
  const mean = sum / sampled
  const variance = Math.max(0, sumSquares / sampled - mean * mean)
  return {
    histogram: counts.map((count) => count / sampled),
    luma: mean,
    contrast: Math.sqrt(variance),
    sampled,
  }
}

// A histogram intersection: the sum of the smaller share in every bucket, so two identical pictures score 1 and two
// disjoint colours score 0.
export function histogramIntersection(a: readonly number[], b: readonly number[]): number {
  let total = 0
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) total += Math.min(a[index] ?? 0, b[index] ?? 0)
  return total
}

// How far a set may spread before it stops looking like one set. Generous on purpose: two photographs of the same scene
// differ, and a check that fails a good set is worse than no check. A different palette is not a small difference —
// the intersection of a blue frame's histogram with a red one's is near zero, far below the limit — and a bright frame
// among dark ones, or a flat frame among textured ones, is the other defect a set of prompts produces.
export const STYLE_LIMITS = { intersection: 0.5, luma: 80, contrastRatio: 4 } as const

export interface SlotStyle {
  readonly slot: string
  readonly style: ImageStyle
}

export interface StyleDeviation {
  readonly slot: string
  readonly why: string
}

// Each slot against the slot that best represents the set. The reference is the medoid — the slot whose histogram is
// closest to all the others — because an average is the wrong yardstick: with two slots it sits exactly halfway between
// them and would score a blue frame and a red one equally, and with three where one is wrong it drags every slot below
// the limit. The medoid is a real picture, so "the set's look" is something a person can point at. Ties keep the earlier
// slot, which makes the answer depend on the slot order and nothing else.
export function styleOutliers(slots: readonly SlotStyle[], limits: typeof STYLE_LIMITS = STYLE_LIMITS): readonly StyleDeviation[] {
  if (slots.length < 2) return []
  const closeness = slots.map((slot, index) =>
    slots.reduce(
      (total, other, otherIndex) =>
        otherIndex === index ? total : total + histogramIntersection(slot.style.histogram, other.style.histogram),
      0,
    ),
  )
  let referenceIndex = 0
  for (let index = 1; index < slots.length; index += 1) {
    if ((closeness[index] ?? 0) > (closeness[referenceIndex] ?? 0)) referenceIndex = index
  }
  const reference = slots[referenceIndex]!.style

  const out: StyleDeviation[] = []
  for (const [index, slot] of slots.entries()) {
    if (index === referenceIndex) continue
    const why: string[] = []
    const intersection = histogramIntersection(slot.style.histogram, reference.histogram)
    if (intersection < limits.intersection) {
      why.push(`its colours overlap the rest of the set by ${intersection.toFixed(2)}, below ${limits.intersection}`)
    }
    if (Math.abs(slot.style.luma - reference.luma) > limits.luma) {
      why.push(`its brightness ${slot.style.luma.toFixed(0)} is ${Math.abs(slot.style.luma - reference.luma).toFixed(0)} from the set's ${reference.luma.toFixed(0)}`)
    }
    const ratio = Math.max(slot.style.contrast, reference.contrast) / Math.max(1, Math.min(slot.style.contrast, reference.contrast))
    if (ratio > limits.contrastRatio) {
      why.push(`its contrast ${slot.style.contrast.toFixed(0)} is ${ratio.toFixed(1)}× the set's ${reference.contrast.toFixed(0)}`)
    }
    if (why.length > 0) out.push({ slot: slot.slot, why: why.join("; ") })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// The prompt checklist.

// Words a prompt uses to hold a sentence together rather than to ask for anything. They are not "subjects", and a check
// that demanded "with" appear in the graph would be checking the wrong thing.
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "along", "also", "among", "and", "around", "because", "been", "before",
  "behind", "being", "below", "beside", "between", "both", "but", "could", "does", "down", "during", "each",
  "from", "have", "into", "its", "itself", "just", "like", "made", "make", "many", "more", "most", "much", "must",
  "near", "only", "onto", "other", "over", "same", "should", "some", "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "under", "until", "upon", "very", "was", "were", "what", "when",
  "where", "which", "while", "will", "with", "within", "without", "would", "your",
])

// The words a prompt asks for: lower-cased, letters and digits only, at least four characters, stopwords and bare
// numbers dropped. Four is where "cat" (three) falls out and "calm", "gradient", "neon", "portrait" stay in; three-letter
// subjects are rare enough that dropping them is better than a check that fails on "the".
export function contentWords(prompt: string): readonly string[] {
  const words: string[] = []
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue
    if (STOPWORDS.has(raw)) continue
    if (/^\d+$/.test(raw)) continue
    if (!words.includes(raw)) words.push(raw)
  }
  return words
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Which of the prompt's content words are missing from the text the graph carries. Whole words only: "art" inside
// "earth" is not the prompt asking for art.
export function missingWords(prompt: string, text: string): readonly string[] {
  return contentWords(prompt).filter((word) => !new RegExp(`(^|[^a-z0-9])${escape(word)}($|[^a-z0-9])`, "i").test(text))
}

// The positive text of a text-to-image graph, found by following the KSampler's `positive` link rather than by taking the
// first CLIPTextEncode in the file — the negative prompt is the other one, and a word that survived only in the negative
// is a word the picture was asked to avoid.
export function positiveTextOf(workflow: unknown): string | undefined {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (!isRecord(workflow)) return undefined
  let positive: string | undefined
  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || node["class_type"] !== "KSampler") continue
    const inputs = node["inputs"]
    if (!isRecord(inputs)) continue
    const link = inputs["positive"]
    if (Array.isArray(link) && typeof link[0] === "string") positive = link[0]
  }
  if (positive === undefined) return undefined
  const node = workflow[positive]
  if (!isRecord(node)) return undefined
  const inputs = node["inputs"]
  if (!isRecord(inputs)) return undefined
  const text = inputs["text"]
  return typeof text === "string" ? text : undefined
}
