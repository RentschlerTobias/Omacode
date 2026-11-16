// The gate every payload that leaves the machine passes (D13, A2-T6). It sits in front of the one function that
// performs a request — src/decider.ts DecisionClient.ask — so no call site can get past it: not the plugin's three
// direct asks, not the context package's N17, not the CLI's benches. A remote destination and no confirmation means no
// request at all.
//
// Three things happen here, in this order:
//   - the deterministic redaction of src/redact.ts (secrets, e-mail, phone, IBAN, card, home paths, IP addresses, and
//     the values the server was told are secret) is applied to the state text and to the questions. Only the result
//     is previewed and sent; the preview never sees the unredacted text either;
//   - "unredactable" is decided, as A2-T5 defines it: the payload carries a `sensitive` guard flag, or the redaction
//     changed nothing in a text of more than 20 words;
//   - the user is shown what would leave and must say "send". There is no other way through: without a preview channel
//     (a CLI run, a session that is itself waiting) the call is kept local, journalled with that reason, and the
//     caller falls back to its own default.
//
// With a local name/address detector on, the preview says so: the names and addresses it found are already placeholders
// by the time this function runs (the vault redacts them), so "send" is the offered answer. Without one, every payload
// is uncertain, and the preview says that too.

import { egressFindings, redactEgress, type Finding } from "./redact.ts"
import type { Question } from "./decider.ts"

// A text this long is not "trivial": if the redaction left every word of it alone, nobody knows whether it is safe.
export const PREVIEW_WORDS = 20

export type EgressAnswer = "send" | "keep-local" | "cancel"
export type EgressVerdict = EgressAnswer | "no-channel"

export interface EgressRequest {
  readonly destination: string // the host the payload would go to, for the preview and the journal
  readonly node?: string // the question node that asks ("N13", "N5", …)
  readonly session?: string // the session the ask belongs to, so the preview wakes the right micromanager
  readonly job?: string
  readonly task?: string
  readonly text: string // the redacted text, exactly as it would leave
  readonly questions: readonly string[]
  readonly words: number
  readonly changed: boolean // the redaction changed something
  readonly unredactable: boolean
  readonly why?: string // why it is unredactable
  readonly replaced: readonly string[] // the rules that matched ("email", "sk-key", "home-path", …), for the preview
  readonly names?: boolean // a local name/address detector is on
}

// The user's answer. undefined means nobody answered (or nobody could be asked), which is "keep local".
export type Confirm = (request: EgressRequest) => Promise<EgressAnswer | undefined>

export interface EgressOptions {
  readonly confirm?: Confirm
  readonly names?: boolean
  readonly secrets?: readonly string[] // values that are secret wherever they appear
}

export interface EgressOutcome {
  readonly verdict: EgressVerdict
  readonly text: string // the redacted text: what was sent, or what would have been
  readonly questions: Record<string, Question> // the redacted questions, in the same shape
  readonly unredactable: boolean
  readonly changed: boolean
  readonly words: number
  readonly reason: string
  readonly destination: string
  readonly why?: string
}

// What the journal keeps of a call: enough to see that it happened, what it carried and whether anyone confirmed it.
export interface EgressSummary {
  readonly verdict: EgressVerdict
  readonly unredactable: boolean
  readonly changed: boolean
  readonly words: number
  readonly reason: string
  readonly destination: string
  readonly why?: string
}

export function summary(outcome: EgressOutcome): EgressSummary {
  return {
    verdict: outcome.verdict,
    unredactable: outcome.unredactable,
    changed: outcome.changed,
    words: outcome.words,
    reason: outcome.reason,
    destination: outcome.destination,
    ...(outcome.why ? { why: outcome.why } : {}),
  }
}

// A request that did not happen, with the gate's own account of why. src/backends.ts journals that account, so a
// refused cloud call is legible in the journal instead of looking like a backend that was down.
export class EgressRefused extends Error {
  readonly outcome: EgressOutcome

  constructor(outcome: EgressOutcome) {
    super(`kept local: ${outcome.reason}`)
    this.outcome = outcome
  }
}

// Whether a payload carries a `sensitive` guard flag. The state is JSON by the time the client sees it (src/backends.ts
// stringifies the object), so it is parsed when it can be, and read as text when it cannot.
export function carriesSensitive(state: string): boolean {
  const flagged = (v: unknown, depth = 0): boolean => {
    if (depth > 8 || v === null || typeof v !== "object") return false
    if (Array.isArray(v)) return v.some((x) => flagged(x, depth + 1))
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (key === "sensitive" && (value === true || (typeof value === "number" && value >= 0.5))) return true
      if (key === "flagged" && Array.isArray(value) && value.includes("sensitive")) return true
      if (flagged(value, depth + 1)) return true
    }
    return false
  }
  try {
    return flagged(JSON.parse(state))
  } catch {
    return /"(?:sensitive)"\s*:\s*(?:true|[1-9][0-9]*|0?\.\d*[1-9])/.test(state)
  }
}

export function wordsOf(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

const rulesOf = (findings: readonly Finding[]): string[] => [...new Set(findings.map((f) => f.rule))].sort()

// The questions carry the same private data the state does, so they are redacted the same way. The caller's questions
// stay as they are: the local backends read them, and the journal keeps them.
export function redactQuestions(questions: Record<string, Question>, secrets: readonly string[] = []): Record<string, Question> {
  const text = JSON.stringify(questions)
  const redacted = redactEgress(text, secrets)
  return JSON.parse(redacted) as Record<string, Question>
}

// The gate. `payload` is what the caller wanted to send; only `outcome.text` and `outcome.questions` may leave.
export async function egress(
  payload: { readonly text: string; readonly questions: Record<string, Question> },
  options: EgressOptions & { readonly destination: string; readonly node?: string; readonly session?: string; readonly job?: string; readonly task?: string },
): Promise<EgressOutcome> {
  const secrets = options.secrets ?? []
  const text = redactEgress(payload.text, secrets)
  const questions = redactQuestions(payload.questions, secrets)
  const changed = text !== payload.text || JSON.stringify(questions) !== JSON.stringify(payload.questions)
  const words = wordsOf(payload.text)
  const sensitive = carriesSensitive(payload.text)
  // Only a text of some length can be "unchanged by redaction": "run the tests" carries nothing to redact and nothing
  // worth hiding.
  const why = sensitive ? "it carries a sensitive guard flag" : !changed && words > PREVIEW_WORDS ? `the redaction changed nothing in ${words} words` : undefined
  const unredactable = why !== undefined
  const base = {
    text,
    questions,
    changed,
    words,
    unredactable,
    destination: options.destination,
    ...(why ? { why } : {}),
  }
  if (!options.confirm) {
    return { ...base, verdict: "no-channel", reason: "no preview channel here, so nothing is sent" }
  }
  const answer = await options.confirm({
    destination: options.destination,
    ...(options.node ? { node: options.node } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.job ? { job: options.job } : {}),
    ...(options.task ? { task: options.task } : {}),
    text,
    questions: Object.keys(questions),
    words,
    changed,
    unredactable,
    ...(why ? { why } : {}),
    replaced: rulesOf([...egressFindings(payload.text, secrets), ...egressFindings(JSON.stringify(payload.questions), secrets)]),
    ...(options.names !== undefined ? { names: options.names } : {}),
  })
  if (answer === "send") return { ...base, verdict: "send", reason: "the user confirmed the preview" }
  if (answer === "cancel") return { ...base, verdict: "cancel", reason: "the user cancelled the send" }
  if (answer === "keep-local") return { ...base, verdict: "keep-local", reason: "the user kept it on this machine" }
  return { ...base, verdict: "keep-local", reason: "nobody confirmed the preview, so nothing is sent" }
}

// Whether a URL leaves this machine. Loopback names are the local decision servers; anything else — a LAN address, a
// hostname, an unknown scheme — is treated as remote, so the gate decides and an unresolvable case is never sent.
export function remote(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.replaceAll("[", "").replaceAll("]", "").toLowerCase()
  } catch {
    return true
  }
  return !(host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host))
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
