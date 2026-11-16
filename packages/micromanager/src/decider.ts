// The decision client: program state + typed questions in, typed answers with probabilities out. It was src/jev.ts
// before A2-T3; the name says what it is, because it now serves the cloud service and the local decision servers
// alike. Wire format (the Jev format, unchanged): POST https://api.typesafe.ai/v1/systemone {model, state, questions}
// -> {model, answers, usage} (the same shape the oc-voice project uses in decision/systemone.py).
//
// This class is URL-agnostic on purpose: the local GLiNER/Open-Jev servers speak the same wire format. The cloud
// client — the cloud URL and a key — is built in one place only, src/backends.ts cloudClient, and only when the
// decider's mode is "cloud" (D11/D19). In "local" mode no key is read and no cloud URL is touched.
//
// A destination that is not this machine passes the egress gate (src/egress.ts) inside ask(): the redaction, the
// preview and the user's confirmation happen here, in the one function that makes a request, so a caller with a raw
// client cannot send anything the gate did not see (D13, A2-T6). A loopback URL is a local server and sends as before.

import { execFileSync } from "node:child_process"

import { egress, EgressRefused, hostOf, remote, summary, type EgressOptions, type EgressSummary } from "./egress.ts"
import { mapStrings, scrub } from "./redact.ts"

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> } // option id -> meaning
  | { type: "score"; instructions: string; criteria: string[] } // rubric levels, lowest first
  | { type: "noul"; instructions: string } // a statement; the service returns the probability that it is true

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }

export interface Decision {
  readonly answers: Record<string, Answer>
  readonly model: string
  readonly latencyMs: number
  // The redacted text that left the machine, and what the gate made of it. Absent for a local server: nothing left.
  readonly sent?: string
  readonly egress?: EgressSummary
}

// What the caller of an ask knows and the client needs: which node asks (the journal and the preview), for which job,
// and — the one thing the preview cannot work without — whose session it belongs to, so the form reaches that session's
// micromanager (A2-T6).
export interface AskContext {
  readonly node: string
  readonly job?: string
  readonly task?: string
  readonly session?: string
}


export class DeciderError extends Error {}

export interface DecisionClientOptions {
  readonly url?: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly retries?: number // on 429/529 only
  readonly maxStateChars?: number
  readonly fetch?: typeof fetch
  // The gate for a destination that is not this machine (src/egress.ts). Without a confirm function every such request
  // is refused before it is made: a raw client has no way to skip the gate, because this class is the only place a
  // request happens.
  readonly egress?: EgressOptions
}


// The cloud key: JEV_API_KEY, else the desktop keyring (secret-tool store --label="TypeSafe Jev API key" service
// typesafe key jev). Only src/backends.ts cloudKey calls this, and only in "cloud" mode: a local start reads neither.
export function cloudApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.JEV_API_KEY) return env.JEV_API_KEY
  try {
    const key = execFileSync("secret-tool", ["lookup", "service", "typesafe", "key", "jev"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return key || undefined
  } catch {
    return undefined
  }
}

// Private data is swapped for the vault's placeholders before the state leaves the machine (src/redact.ts); with
// redaction off, keys and tokens are still masked. A payload for another machine goes through the egress gate instead
// (src/egress.ts), which redacts a little more and asks the user first.
export function redact(text: string): string {
  return scrub(text)
}

// The question texts carry the same private data the state does, so the wire body gets a redacted copy. The caller's
// questions stay as they are: the ask flow journals them, and the local backends read them too.
function wireQuestions(questions: Record<string, Question>): Record<string, Question> {
  const copy = JSON.parse(JSON.stringify(questions)) as Record<string, Question>
  mapStrings(copy, redact)
  return copy
}

export class DecisionClient {
  readonly #key: string
  readonly #url: string
  readonly #model: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #maxStateChars: number
  readonly #fetch: typeof fetch
  readonly #egress: EgressOptions
  readonly #remote: boolean

  constructor(key: string, options: DecisionClientOptions = {}) {
    this.#key = key
    this.#url = options.url ?? "https://api.typesafe.ai/v1/systemone"
    this.#model = options.model ?? "jev-latest"
    this.#timeoutMs = options.timeoutMs ?? 3000
    this.#retries = options.retries ?? 1
    this.#maxStateChars = options.maxStateChars ?? 24000
    this.#fetch = options.fetch ?? fetch
    this.#egress = options.egress ?? {}
    this.#remote = remote(this.#url)
  }

  async ask(state: string, questions: Record<string, Question>, context?: AskContext): Promise<Decision> {
    // The newest part of the state is at the end; a cut keeps it.
    const cut = state.length > this.#maxStateChars ? state.slice(-this.#maxStateChars) : state
    let body: string
    let sent: string | undefined
    let egressSummary: EgressSummary | undefined
    if (this.#remote) {
      // Nothing goes out of this machine without passing the gate: it redacts, previews and takes the user's answer, or
      // it refuses and this throws before a request exists.
      const outcome = await egress({ text: cut, questions }, {
        ...this.#egress,
        destination: hostOf(this.#url),
        ...(context?.node ? { node: context.node } : {}),
        ...(context?.job ? { job: context.job } : {}),
        ...(context?.task ? { task: context.task } : {}),
        ...(context?.session ? { session: context.session } : {}),
      })
      if (outcome.verdict !== "send") throw new EgressRefused(outcome)
      sent = outcome.text
      egressSummary = summary(outcome)
      body = JSON.stringify({ model: this.#model, state: outcome.text, questions: outcome.questions })
    } else {
      body = JSON.stringify({ model: this.#model, state: redact(cut), questions: wireQuestions(questions) })
    }
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.#fetch(this.#url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (err) {
        throw new DeciderError(`decision server unreachable: ${err instanceof Error ? err.name : String(err)}`)
      }
      if ((response.status === 429 || response.status === 529) && attempt < this.#retries) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt))
        continue
      }
      if (response.status === 401) throw new DeciderError("decision server: API key rejected (401)")
      if (response.status !== 200) throw new DeciderError(`decision server: HTTP ${response.status}`)
      const payload = (await response.json()) as { model?: string; answers?: Record<string, unknown> }
      return {
        answers: parseAnswers(questions, payload.answers ?? {}),
        model: payload.model ?? this.#model,
        latencyMs: Date.now() - started,
        ...(sent !== undefined ? { sent } : {}),
        ...(egressSummary ? { egress: egressSummary } : {}),
      }
    }
  }
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new DeciderError(`decision server: missing numeric ${what}`)
  return value
}

function probs(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "number")) as Record<string, number>
}

export function parseAnswers(questions: Record<string, Question>, raw: Record<string, unknown>): Record<string, Answer> {
  const answers: Record<string, Answer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const data = raw[id] as Record<string, unknown> | undefined
    if (!data) continue
    if (question.type === "choice") {
      const choice = data.choice
      if (typeof choice !== "string" || !(choice in question.criteria)) throw new DeciderError(`decision server: ${id}: choice not offered`)
      answers[id] = { type: "choice", choice, confidence: num(data.confidence, `${id}.confidence`), probabilities: probs(data.probabilities) }
    } else if (question.type === "score") {
      answers[id] = { type: "score", score: num(data.score, `${id}.score`), confidence: num(data.confidence, `${id}.confidence`), probabilities: probs(data.probabilities) }
    } else {
      const noul = num(data.noul, `${id}.noul`)
      if (noul < 0 || noul > 1) throw new DeciderError(`decision server: ${id}: noul outside 0..1`)
      answers[id] = { type: "noul", noul }
    }
  }
  return answers
}
