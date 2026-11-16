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
