// The preview of a cloud send, and the one question it asks (D13, A2-T6). Nothing leaves the machine until the user has
// seen the text and said "send"; "keep it local" and "cancel" leave no request at all.
//
// The plugin cannot open a form itself (src/forms.ts: its context has no form domain), so a preview waits the way a
// grant waits: the request is opened here, its id is the form's header, and the micromanager session puts the form to
// the user with the question tool. The answer comes back through tool.execute.after, which settles the promise the
// cloud call is waiting on. Without an answer it is kept local after the timeout — never sent.
//
// This file only shapes the question and the note; src/plugin.ts owns the session that puts it.

import { formInput, type Question } from "./forms.ts"
import type { EgressAnswer, EgressRequest } from "./egress.ts"

// Two minutes: long enough for the user who is at the screen, short enough that a worker's permission request is not
// held hostage. A cloud call that times out is kept local and says so in the journal.
export const PREVIEW_TIMEOUT_MS = 2 * 60_000

const SEND = "Send it"
const LOCAL = "Keep it local"
const CANCEL = "Cancel"

export interface PendingPreview extends EgressRequest {
  readonly id: string // "S1", the form's header
  readonly at: number
}

interface Waiting extends PendingPreview {
  readonly answer: Promise<EgressAnswer>
  readonly settle: (answer: EgressAnswer) => void
  timer?: ReturnType<typeof setTimeout>
}

// The previews waiting for an answer. One per id; a second ask of the same node in the same text waits on the first
// form rather than putting a second one.
export class PreviewRequests {
  readonly #pending = new Map<string, Waiting>()
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #timeoutMs: number
  #n = 0

  constructor(journal: (entry: Record<string, unknown>) => void = () => {}, timeoutMs = PREVIEW_TIMEOUT_MS) {
    this.#journal = journal
    this.#timeoutMs = timeoutMs
  }

  open(request: EgressRequest): { pending: PendingPreview; answer: Promise<EgressAnswer>; fresh: boolean } {
    const same = [...this.#pending.values()].find((p) => p.destination === request.destination && p.text === request.text)
    if (same) return { pending: strip(same), answer: same.answer, fresh: false }
    const id = `S${++this.#n}`
    let settle!: (answer: EgressAnswer) => void
    const answer = new Promise<EgressAnswer>((resolve) => (settle = resolve))
    const waiting: Waiting = { ...request, id, at: Date.now(), answer, settle }
    waiting.timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return
      this.#journal({ kind: "egress", event: "timeout", id, node: request.node, destination: request.destination, session: request.session })
      settle("keep-local")
    }, this.#timeoutMs)
    waiting.timer.unref?.()
    this.#pending.set(id, waiting)
    this.#journal({ kind: "egress", event: "asked", id, node: request.node, destination: request.destination, session: request.session, job: request.job, words: request.words, unredactable: request.unredactable, replaced: request.replaced })
    return { pending: strip(waiting), answer, fresh: true }
  }

  get(id: string): PendingPreview | undefined {
    const p = this.#pending.get(id)
    return p && strip(p)
  }

  // The user's answer. Returns the preview it settled, or undefined when none waits under this id any more.
  answer(id: string, choice: EgressAnswer): PendingPreview | undefined {
    const p = this.#take(id)
    if (!p) return undefined
    this.#journal({ kind: "egress", event: "answered", id, node: p.node, destination: p.destination, session: p.session, job: p.job, answer: choice, waitedMs: Date.now() - p.at })
    p.settle(choice)
    return strip(p)
  }

  // The previews of sessions that ended: kept local quietly, nobody waits for them any more.
  drop(sessionIDs: readonly string[]): PendingPreview[] {
    const dropped = [...this.#pending.values()].filter((p) => p.session !== undefined && sessionIDs.includes(p.session))
    for (const p of dropped) {
      this.#take(p.id)
      this.#journal({ kind: "egress", event: "dropped", id: p.id, node: p.node, destination: p.destination, session: p.session, job: p.job })
      p.settle("keep-local")
    }
    return dropped.map(strip)
  }

  #take(id: string): Waiting | undefined {
    const p = this.#pending.get(id)
    if (!p) return undefined
    this.#pending.delete(id)
    clearTimeout(p.timer)
    return p
  }
}

function strip(p: Waiting): PendingPreview {
  const { settle: _s, timer: _t, answer: _a, ...shown } = p
  return shown
}

// The header a form is recognised by: "Send S1" (src/plugin.ts reads the answer by it, as it does for grants).
export const previewHeader = (id: string): string => `Send ${id}`

const SHOWN = 1200

// The form: the host, what the redaction changed, whether the payload is one nobody can vouch for, and the first
// characters of the exact text that would leave. Enough to recognise the payload, never the whole of it.
export function previewForm(p: PendingPreview): Question[] {
  const what = p.replaced.length ? `Redacted: ${p.replaced.join(", ")}.` : "Nothing in it matched a detector."
  const sure = p.unredactable
    ? `It is not one that can be vouched for: ${p.why ?? "the redaction left it unchanged"}.`
    : p.names
      ? "Names and addresses are replaced by the local detector; e-mail, keys, paths and addresses by the redaction."
      : "No local name detector is on, so this payload is uncertain: read the text before you send it."
  const tail = p.text.length > SHOWN ? `${p.text.slice(0, SHOWN)}\n… (${p.text.length - SHOWN} more characters)` : p.text
  return [{
    header: previewHeader(p.id),
    question:
      `${p.node ?? "A decision"} would send ${p.words} word${p.words === 1 ? "" : "s"} to ${p.destination}${p.job ? ` for job ${p.job}` : ""}. ` +
      `${what} ${sure}\n\n${tail}\n\nSend it?`,
    options: [
      { label: SEND, description: `This payload leaves the machine, as shown, once` },
      { label: LOCAL, description: "Nothing is sent; the decision is answered on this machine or by you" },
      { label: CANCEL, description: "Nothing is sent, and this decision is not asked again for this call" },
    ],
  }]
}

// The note that wakes the micromanager: the form to put to the user, exactly as it is.
export function previewNote(p: PendingPreview, timeoutMs = PREVIEW_TIMEOUT_MS): string {
  return `[micromanager] ${p.id}: a cloud decision waits for the user's word. ${p.node ?? "a decision"} would send ${p.words} words to ${p.destination}${p.job ? ` for job ${p.job}` : ""}. Only the user may let a payload leave this machine: ask them with the question tool, with exactly this input (a form; their answer reaches the plugin by itself), then end your turn:\n${formInput(previewForm(p))}\nWithout an answer it is kept local in ${Math.round(timeoutMs / 60_000)} minutes and the decision is made without the cloud.`
}

// What the user's answer means. A short yes or no they typed themselves is taken the same way; anything else is no
// answer, and the preview keeps waiting.
export function previewAnswer(labels: readonly string[]): EgressAnswer | undefined {
  for (const label of labels) {
    const said = label.trim().toLowerCase().replace(/\s*\(recommended\)\s*$/, "").replace(/\s+/g, " ")
    if (said === SEND.toLowerCase() || ["send", "yes", "ja", "send it"].includes(said)) return "send"
    if (said === LOCAL.toLowerCase() || ["keep local", "keep it local", "local", "no", "nein"].includes(said)) return "keep-local"
    if (said === CANCEL.toLowerCase() || ["stop", "abort", "cancel it"].includes(said)) return "cancel"
  }
  return undefined
}

// --- the per-session cloud opt-in (A2-T5) ------------------------------------------------------------------------

// The opt-in is a value of a session, not of a job and not of the machine. It is asked once, through the same channel
// as the preview (the session's micromanager puts the form), and it is remembered for the session until it expires or
// the job it was given for changes; then the session's first cloud ask asks again. A "keep it local" answer is
// remembered just the same, so the user is not asked before every decision.
//
// The guards are a second answer: a session may let ordinary decisions go to the cloud and still keep injection
// and sensitive on this machine, which is the default and the only thing a plain opt-in allows.

// A working day. Long enough not to nag within one, short enough that yesterday's yes is asked again.
export const OPT_IN_TTL_MS = 12 * 60 * 60_000

const CLOUD = "Cloud for this session"
const GUARDS = "Cloud and guards"
const KEEP = "Keep it local"

export type OptInAnswer = "cloud" | "guards" | "local"
export type OptInNeed = "none" | "stale" | "job" | "ok" | "local"

export interface OptInState {
  readonly allow: boolean // this session may use the cloud
  readonly guards: boolean // and its guard questions may go too
  readonly need: OptInNeed // none/stale/job mean "ask"; ok/local mean the answer stands
  readonly why: string // for the journal and the form
}

export interface PendingOptIn {
  readonly id: string // "O1", the form's header
  readonly session: string
  readonly job?: string
  readonly at: number
}

interface WaitingOptIn extends PendingOptIn {
  readonly answer: Promise<OptInAnswer>
  readonly settle: (answer: OptInAnswer) => void
  timer?: ReturnType<typeof setTimeout>
}

// The answers and the forms that wait for one. It does not wake anyone itself: the plugin gives it a channel through
// the session's micromanager (src/plugin.ts), so this file stays testable without a host.
export class CloudOptIn {
  readonly #decided = new Map<string, { job?: string; at: number; answer: OptInAnswer }>()
  readonly #pending = new Map<string, WaitingOptIn>()
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #timeoutMs: number
  readonly #ttlMs: number
  #n = 0

  constructor(journal: (entry: Record<string, unknown>) => void = () => {}, timeoutMs = PREVIEW_TIMEOUT_MS, ttlMs = OPT_IN_TTL_MS) {
    this.#journal = journal
    this.#timeoutMs = timeoutMs
    this.#ttlMs = ttlMs
  }

  // What this session already decided, and whether that answer still stands. The job is compared only when the ask
  // names one: an opt-in given without a job is not thrown away by an ask that has one, it is re-confirmed once.
  state(session: string, job?: string, now = Date.now()): OptInState {
    const rec = this.#decided.get(session)
    if (!rec) return { allow: false, guards: false, need: "none", why: "this session has not opted in to the cloud" }
    if (now - rec.at >= this.#ttlMs) return { allow: false, guards: false, need: "stale", why: "the session's cloud opt-in expired" }
    if (job !== undefined && rec.job !== job) return { allow: false, guards: false, need: "job", why: "the session opted in for another job" }
    return {
      allow: rec.answer !== "local",
      guards: rec.answer === "guards",
      need: rec.answer === "local" ? "local" : "ok",
      why: rec.answer === "local" ? "the user kept this session local" : "the session opted in",
    }
  }

  // Remember an answer for the session. It replaces an earlier one, and the guard override with it: the override
  // cannot outlive the answer that carried it.
  remember(session: string, job: string | undefined, answer: OptInAnswer, at = Date.now()): OptInState {
    this.#decided.set(session, { ...(job !== undefined ? { job } : {}), at, answer })
    this.#journal({ kind: "cloud-opt-in", event: "decided", session, job, answer })
    return this.state(session, job, at)
  }

  // One form per session and job: a second ask while the first waits is answered by the same form.
  open(session: string, job?: string): { pending: PendingOptIn; answer: Promise<OptInAnswer>; fresh: boolean } {
    const same = [...this.#pending.values()].find((p) => p.session === session && p.job === job)
    if (same) return { pending: stripOptIn(same), answer: same.answer, fresh: false }
    const id = `O${++this.#n}`
    let settle!: (answer: OptInAnswer) => void
    const answer = new Promise<OptInAnswer>((resolve) => (settle = resolve))
    const waiting: WaitingOptIn = { id, session, ...(job !== undefined ? { job } : {}), at: Date.now(), answer, settle }
    waiting.timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return
      this.#journal({ kind: "cloud-opt-in", event: "timeout", id, session, job })
      // No answer is a no, remembered like one: the session is not asked before every decision, and nothing leaves.
      this.remember(session, job, "local")
      settle("local")
    }, this.#timeoutMs)
    waiting.timer.unref?.()
    this.#pending.set(id, waiting)
    this.#journal({ kind: "cloud-opt-in", event: "asked", id, session, job })
    return { pending: stripOptIn(waiting), answer, fresh: true }
  }

  get(id: string): PendingOptIn | undefined {
    const p = this.#pending.get(id)
    return p && stripOptIn(p)
  }

  // The user's answer. Returns the request it settled, or undefined when none waits under this id any more.
  answer(id: string, choice: OptInAnswer): PendingOptIn | undefined {
    const p = this.#take(id)
    if (!p) return undefined
    this.#journal({ kind: "cloud-opt-in", event: "answered", id, session: p.session, job: p.job, answer: choice, waitedMs: Date.now() - p.at })
    // The answer is remembered per session, whatever it was: "keep it local" too, so the user is not asked before every
    // decision. The guard override lives in the same record, so it can never outlive the answer that carried it.
    this.remember(p.session, p.job, choice)
    p.settle(choice)
    return stripOptIn(p)
  }

  // The sessions that ended: their forms are dropped, and their answers with them. An opt-in cannot outlive its
  // session, and neither can a guard override.
  drop(sessions: readonly string[]): PendingOptIn[] {
    const dropped = [...this.#pending.values()].filter((p) => sessions.includes(p.session))
    for (const p of dropped) {
      this.#take(p.id)
      this.#journal({ kind: "cloud-opt-in", event: "dropped", id: p.id, session: p.session, job: p.job })
      p.settle("local")
    }
    for (const session of sessions) {
      if (this.#decided.delete(session)) this.#journal({ kind: "cloud-opt-in", event: "forgotten", session })
    }
    return dropped.map(stripOptIn)
  }

  #take(id: string): WaitingOptIn | undefined {
    const p = this.#pending.get(id)
    if (!p) return undefined
    this.#pending.delete(id)
    clearTimeout(p.timer)
    return p
  }
}

function stripOptIn(p: WaitingOptIn): PendingOptIn {
  const { settle: _s, timer: _t, answer: _a, ...shown } = p
  return shown
}

// The header a form is recognised by: "Cloud O1" (src/plugin.ts reads the answer by it, as it does for grants).
export const optInHeader = (id: string): string => `Cloud ${id}`

// The form: the three answers, with what each one means for this session. No payload is shown here — that is the
// preview, after the opt-in and per call.
export function optInForm(p: PendingOptIn): Question[] {
  return [{
    header: optInHeader(p.id),
    question:
      `May decisions in this session go to the cloud decision client${p.job ? ` for job ${p.job}` : ""}? ` +
      "Each send is still redacted and shown to you before it leaves. The answer holds for this session only.",
    options: [
      { label: CLOUD, description: "Ordinary decisions may reach the cloud, after a redacted preview you confirm; the guards stay on this machine" },
      { label: GUARDS, description: "The same, and the guard questions (injection, sensitive) may go too — for this session only; a payload carrying the sensitive flag is never sent by this" },
      { label: KEEP, description: "Nothing leaves this machine in this session; every decision is answered locally or by you" },
    ],
  }]
}

// The note that wakes the micromanager for a session that has not opted in.
export function optInNote(p: PendingOptIn, timeoutMs = PREVIEW_TIMEOUT_MS): string {
  return `[micromanager] ${p.id}: the decision client asks whether this session may use the cloud${p.job ? ` (job ${p.job})` : ""}. Only the user may say so, once per session: ask them with the question tool, with exactly this input (a form; their answer reaches the plugin by itself), then end your turn:\n${formInput(optInForm(p))}\nWithout an answer everything stays on this machine in ${Math.round(timeoutMs / 60_000)} minutes, and the decision is made locally.`
}

// What the user's answer means. As with the preview, a short yes or no they typed themselves counts.
export function optInAnswer(labels: readonly string[]): OptInAnswer | undefined {
  for (const label of labels) {
    const said = label.trim().toLowerCase().replace(/\s*\(recommended\)\s*$/, "").replace(/\s+/g, " ")
    if (said === GUARDS.toLowerCase() || ["cloud and guards", "guards too", "cloud, guards too"].includes(said)) return "guards"
    if (said === CLOUD.toLowerCase() || ["cloud", "cloud for this session", "yes", "ja", "allow cloud"].includes(said)) return "cloud"
    if (said === KEEP.toLowerCase() || ["keep it local", "keep local", "local", "no", "nein"].includes(said)) return "local"
  }
  return undefined
}
