// Training rows from the journal (design.md §15, §20): Open-Jev JSONL for a local Jev, GLiNER2 JSO lines for the
// decision server's fine-tune.
//
// A row's target is, in this order: a label the user gave or an outcome (one-hot, the strongest), else the cloud
// Jev's own probabilities (a soft distillation target). Answers of GLiNER or the rules are never targets.
//
// LOCAL_NODES is what the local model is expected to answer (A2b-T1): the three clean guards, the permission node with
// its own questions, and every planning/working node that otherwise asks the user. A local model trained on the guards
// alone makes the ask storm worse, not better.

import { createHash } from "node:crypto"

import { GUARDS } from "./catalog.ts"
import { PERMISSION_NODE, PERMISSION_QUESTIONS, RELEVANCE_QUESTION } from "./decide.ts"
import type { Answer, Question } from "./decider.ts"
import { record, type Entry } from "./journal.ts"

export interface Labeled {
  readonly entry: Entry // the decision
  readonly qid: string
  readonly question: Question
  readonly answer?: Answer
  readonly label?: { readonly value: string | number; readonly source: string }
}

// The nodes the local model must answer. The guards are named as the plugin names them; `G` is the gate as a whole.
// N13 is the permission node: its questions are the ones a local decider needs to cut the ask storm.
export const LOCAL_NODES: readonly string[] = ["G0", "G0.injection", "G", "N1", "N2", "N4", "N5", "N7", "N8", "N10", PERMISSION_NODE, "N14", "N15", "N16", "git"]

// The questions each locally-served node answers. Nodes whose questions are built per task (N4, N7, N5, …) are not
// listed: their rows come from the journal with the questions that were actually asked.
export function localQuestions(node: string, withRelevance = false): Record<string, Question> | undefined {
  if (node === "G0" || node === "G") return GUARDS
  if (node === "G0.injection") return { injection: GUARDS.injection }
  if (node === PERMISSION_NODE) return withRelevance ? { ...PERMISSION_QUESTIONS, path_relevance: RELEVANCE_QUESTION } : PERMISSION_QUESTIONS
  return undefined
}

// How strong a label is (A2b-T2): the user's own word first, then an observed outcome, then nothing — the cloud answer
// is the fallback target in target(), not a label. An outcome never overwrites what the user said.
const LABEL_STRENGTH: Record<string, number> = { user: 4, user_override: 4, planning_answer: 3, outcome: 2 }

// Joins every decision question with its strongest label; among labels of equal strength the newest wins.
export function labeled(entries: readonly Entry[]): Labeled[] {
  const labels = new Map<string, { value: string | number; source: string }>()
  for (const e of entries) {
    if (e.kind === "label" && typeof e.decision === "string" && typeof e.question === "string") {
      const key = `${e.decision}/${e.question}`
      const source = String(e.source)
      const seen = labels.get(key)
      if (seen && (LABEL_STRENGTH[seen.source] ?? 0) > (LABEL_STRENGTH[source] ?? 0)) continue
      labels.set(key, { value: e.value as string | number, source })
    }
  }
  const out: Labeled[] = []
  for (const e of entries) {
    if (e.kind !== "decision" || typeof e.id !== "string") continue
    const questions = (e.questions ?? {}) as Record<string, Question>
    const answers = (e.answers ?? {}) as Record<string, Answer>
    for (const [qid, question] of Object.entries(questions)) {
      out.push({ entry: e, qid, question, answer: answers[qid], label: labels.get(`${e.id}/${qid}`) })
    }
  }
  return out
}

export function options(q: Question): string[] {
  if (q.type === "choice") return Object.keys(q.criteria)
  if (q.type === "noul") return ["no", "yes"]
  return [...q.criteria]
}

// The target distribution over options(), or undefined when nothing may serve as a target.
export function target(row: Labeled): { probs: number[]; source: string } | undefined {
  const opts = options(row.question)
  if (row.label) {
    const v = row.label.value
    const index = row.question.type === "noul"
      ? (v === "yes" || v === 1 ? 1 : 0)
      : row.question.type === "score" && typeof v === "number" ? Math.round(v) : opts.indexOf(String(v))
    if (index < 0 || index >= opts.length) return undefined
    return { probs: opts.map((_, i) => (i === index ? 1 : 0)), source: row.label.source }
  }
  if (row.entry.backend !== "cloud" || !row.answer) return undefined
  const a = row.answer
  if (a.type === "noul") return { probs: [1 - a.noul, a.noul], source: "jev" }
  const p = opts.map((o, i) => a.probabilities[o] ?? a.probabilities[String(i)] ?? 0)
  const sum = p.reduce((x, y) => x + y, 0)
  if (sum <= 0) return undefined
  return { probs: p.map((x) => x / sum), source: "jev" }
}

// 80 / 5 / 5 / 10 by a hash of the group, so one job or task never spans two splits.
export function splitOf(group: string): "train" | "calibration" | "validation" | "test" {
  const n = parseInt(createHash("sha256").update(group).digest("hex").slice(0, 8), 16) % 100
  return n < 80 ? "train" : n < 85 ? "calibration" : n < 90 ? "validation" : "test"
}

// --- permission outcomes (A2b-T2) -------------------------------------------------------------------------
// What a permission decision turned out to be worth, recorded after the fact: the worker was allowed and the work
// succeeded, the denial held and the worker found another way, or the user overrode the automatic verdict. It labels
// the `answer` question; the user's own label still wins over it (labeled()).
export const PERMISSION_OUTCOMES = ["allowed-and-succeeded", "denied-and-retried", "user-overrode"] as const
export type PermissionOutcome = (typeof PERMISSION_OUTCOMES)[number]

export function permissionTarget(outcome: PermissionOutcome, automatic: "allow" | "deny"): "allow" | "deny" {
  if (outcome === "allowed-and-succeeded") return "allow"
  if (outcome === "denied-and-retried") return "deny"
  // The user overrode it, so the automatic verdict was the wrong one.
  return automatic === "allow" ? "deny" : "allow"
}

export function labelPermission(
  decisionId: string,
  outcome: PermissionOutcome,
  automatic: "allow" | "deny",
  journal: (entry: Record<string, unknown>) => void = record,
): void {
  journal({ kind: "label", decision: decisionId, question: "answer", value: permissionTarget(outcome, automatic), source: "outcome", outcome })
}

const groupOf = (e: Entry) => String(e.task ?? e.job ?? e.id)

export function openJevRows(entries: readonly Entry[]): Record<string, unknown>[] {
  return labeled(entries).flatMap((row) => {
    const t = target(row)
    if (!t) return []
    const group = groupOf(row.entry)
    return [{
      id: `${row.entry.id}/${row.qid}`,
      group_id: group,
      split: splitOf(group),
      source: "micromanager",
      state: row.entry.state,
      question: row.question.instructions,
      kind: row.question.type,
      options: options(row.question),
      target: t.probs,
      metadata: {
        node: row.entry.node,
        qid: row.qid,
        backend: row.entry.backend,
        label_source: t.source,
        time: row.entry.time,
        ...(row.question.type === "choice" ? { option_meanings: row.question.criteria } : {}),
        ...(row.question.type === "score" ? { score_values: options(row.question).map((_, i) => i) } : {}),
      },
    }]
  })
}

// The text the decision server builds from a state object: the task text first, so a short GLiNER window keeps
// it. decider/decider/server.py renders the same way.
const FIRST = ["text", "utterance", "task", "question"]
export function renderState(state: unknown): string {
  if (typeof state === "string") return state
  if (!state || typeof state !== "object") return String(state)
  const entries = Object.entries(state as Record<string, unknown>)
  entries.sort(([a], [b]) => {
    const ia = FIRST.indexOf(a), ib = FIRST.indexOf(b)
    return (ia < 0 ? FIRST.length : ia) - (ib < 0 ? FIRST.length : ib)
  })
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
}

const YES_NO = { yes: "Yes, the statement is true for this text.", no: "No, the statement is false for this text." }
const safe = (s: string) => s.replace(/\(/g, ", ").replace(/[)[\]]/g, "")

// GLiNER2 JSO lines (oc-voice training/tasks.py): hard labels only, the argmax of the target. Score questions are part
// of the export too (path_relevance, complexity, risk): their levels are the labels, numbered as the wire format asks
// them. Choice questions keep their option ids, so the model's task/label names match what the server sends.
export function glinerRows(entries: readonly Entry[]): Record<string, unknown>[] {
  return labeled(entries).flatMap((row) => {
    const t = target(row)
    if (!t) return []
    const names = options(row.question)
    const index = t.probs.indexOf(Math.max(...t.probs))
    const described = row.question.type === "noul"
      ? Object.fromEntries(Object.entries(YES_NO).map(([k, v]) => [k, safe(v)]))
      : row.question.type === "choice"
        ? Object.fromEntries(Object.entries(row.question.criteria).map(([k, v]) => [k, safe(v)]))
        : Object.fromEntries(names.map((level, i) => [String(i), safe(level)]))
    const trueLabel = row.question.type === "score" ? String(index) : names[index]
    return [{
      input: renderState(row.entry.state),
      node: row.entry.node,
      output: { classifications: [{ task: row.qid, labels: described, true_label: trueLabel, prompt: safe(row.question.instructions), label_descriptions: described }] },
    }]
  })
}
