// The user's consent before something omacode would keep on this machine goes to a cloud model (decided by the user,
// 2026-11-25). Two cases ask:
//
//   "sensitive"  a job or task the sensitive guard flagged, with no local model running to do it;
//   "unchecked"  a request to a cloud model while the decider is down, so names and addresses were not looked for
//                (keys, e-mail, phone, IBAN and card numbers are still replaced: rules find those).
//
// Never silently, and never once per request: an agent sends dozens of requests per task. One answer holds for its
// scope — a job, or for "unchecked" the root session the request belongs to — and a refusal holds the same way, so a
// refused scope is not asked again either. Requests that arrive while the question is open wait for the same answer.
//
// The question is OpenCode's own permission dialog (permission.assert), put in the session the user is looking at,
// never answered by an agent: the micromanager is an LLM a worker's output can steer. For an action it does not know,
// OpenCode 2.2.5's dialog shows nothing but the action's name ("Call tool <action>"; neither the message nor the
// metadata, live check 2026-11-25), so the name is the question, one per kind. The details go to the journal only:
// a note posted into the conversation while the turn ran arrived after it as input for the model, which then answered
// the note instead of the user (same check). Whether the user picks "once" or "always", it is consent for the scope:
// the plugin cannot tell the two apart, and asking again on the next request is what this exists to avoid.

export const CONSENT_ACTIONS: Readonly<Record<ConsentKind, string>> = {
  sensitive: "send_sensitive_work_to_a_cloud_model",
  unchecked: "send_to_a_cloud_model_without_the_name_check",
}

export const isConsentAction = (action: string): boolean => Object.values(CONSENT_ACTIONS).includes(action)

export type ConsentKind = "sensitive" | "unchecked"

export interface ConsentHost {
  readonly permission: {
    assert(args: { action: string; resources: readonly string[]; sessionID?: string; agent?: string; metadata?: Record<string, unknown> }): Promise<unknown>
  }
}

export interface ConsentRequest {
  readonly kind: ConsentKind
  readonly scope: string // a job id, or a root session id
  readonly sessionID: string // where the question is put: the session the user is looking at
  readonly agent?: string
  readonly title: string // a one-line summary, for the journal
  readonly text: string // the details, for the journal (OpenCode's dialog shows only the action's name)
  readonly journal?: (entry: Record<string, unknown>) => void
}

interface ConsentState {
  readonly answers: Map<string, boolean>
  readonly pending: Map<string, Promise<boolean>>
}

// One state for every instance of the plugins in this process, so the guard and the orchestrator share answers.
const STATE: ConsentState = ((globalThis as { __omacodeConsent?: ConsentState }).__omacodeConsent ??= { answers: new Map(), pending: new Map() })

const keyOf = (kind: ConsentKind, scope: string) => `${kind}\0${scope}`

// The answer already given for this scope, if any.
export function consentGiven(kind: ConsentKind, scope: string): boolean | undefined {
  return STATE.answers.get(keyOf(kind, scope))
}

// Asks once per scope; every later call, and every call while the question is open, gets the same answer.
export async function askConsent(host: ConsentHost, request: ConsentRequest): Promise<boolean> {
  const key = keyOf(request.kind, request.scope)
  const known = STATE.answers.get(key)
  if (known !== undefined) return known
  const open = STATE.pending.get(key)
  if (open) return open
  const asking = (async () => {
    let allowed: boolean
    try {
      await host.permission.assert({
        action: CONSENT_ACTIONS[request.kind],
        resources: [request.scope],
        sessionID: request.sessionID,
        ...(request.agent ? { agent: request.agent } : {}),
        metadata: { kind: request.kind, title: request.title, text: request.text },
      })
      allowed = true
    } catch {
      allowed = false
    }
    STATE.answers.set(key, allowed)
    STATE.pending.delete(key)
    request.journal?.({ kind: "consent", consent: request.kind, scope: request.scope, sessionID: request.sessionID, allowed, title: request.title, text: request.text })
    return allowed
  })()
  STATE.pending.set(key, asking)
  return asking
}

// The session a request belongs to, followed up to the one the user started: a worker's answer is its job's, and the
// question is put where the user is. `get` is OpenCode's session lookup; a lookup that fails ends the walk there.
export async function rootSession(get: (sessionID: string) => Promise<{ parentID?: string } | undefined>, sessionID: string): Promise<string> {
  let current = sessionID
  for (let depth = 0; depth < 8; depth++) {
    const record = await get(current).catch(() => undefined)
    if (!record?.parentID) return current
    current = record.parentID
  }
  return current
}

// Loopback means this machine. `localhost`, the IPv4 loopback block, IPv6's `::1` and an IPv4-mapped `::1` all count;
// `0.0.0.0` does not, because it is an address to bind, not one to connect to.
export function isLoopback(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()
  } catch {
    return false
  }
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.") || host.startsWith("::ffff:127.")
}

// For tests: forget every answer.
export function resetConsent(): void {
  STATE.answers.clear()
  STATE.pending.clear()
}
