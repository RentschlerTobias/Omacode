// The cloud image backend (B5-T3), as much of it as can be honest today: a shape that is only constructed when a key is
// configured, and a refusal with a stated reason instead of a second egress gate.
//
// D13 puts one gate in front of every payload that leaves the machine, and that gate is `packages/micromanager/src/
// egress.ts` — the plugin's, wrapped around the decider's client so no call site can bypass it. The artifact package may
// not import it: `@omacode/micromanager` depends on `@omacode/artifact`, and this module reaching back would be a cycle
// between a package and its own consumer. Writing a second gate here would be worse than the cycle — two gates are two
// answers to "may this leave", and the weaker one would become the one adapters use.
//
// So this file builds the backend when a key exists and refuses to send anything, naming the missing pieces, rather than
// pretending a cloud render works. That is the honest half of B5-T3: keys are read, the budget is named as the daemon's
// ledger (B6), the provider's terms are recorded as the caller states them, and no request is made. The day the gate is
// reachable — by moving the gate into a package both sides may import, which is a decision for the round that owns D13,
// not for this one — the `generate` call gains a body and this comment loses its second paragraph.
//
// The key is never logged, echoed in a refusal or written anywhere. A configured key is a fact this module reads and
// does not repeat.

// The environment name a key is configured under. Named so a person can find it in their own shell config; the value is
// never printed, and the adapter has no spec field that can reach it.
export const CLOUD_IMAGE_KEY_ENV = "OMACODE_IMAGE_API_KEY"

export interface CloudImageOptions {
  readonly apiKey?: string
  // What one request may cost, in US dollars. A number rather than a promise: without a ledger (B6) nothing can spend
  // against it, and the refusal says so.
  readonly budgetUsd?: number
  // The hosted provider's terms, as the caller read them. Optional for the same reason: nothing is sent, so nothing
  // depends on them yet.
  readonly terms?: string
}

export interface CloudImageRequest {
  readonly prompt: string
  readonly negative?: string
  readonly size: { readonly width: number; readonly height: number }
  readonly seed?: number
}

// What a cloud backend answers. A refusal value, like the ComfyUI client's, so a caller handles "not sent" the same way
// it handles "the server said no".
export interface CloudImageRefusal {
  readonly ok: false
  readonly refused: string
}

export interface CloudImageBackend {
  readonly name: "cloud"
  // Always false here: the backend exists, the call does not leave. The field is what a caller branches on rather than
  // catching an exception to find out.
  readonly available: boolean
  readonly refusal: string
  readonly budgetUsd?: number
  readonly terms?: string
  generate(request: CloudImageRequest): Promise<CloudImageRefusal>
}

export type CloudImageSetup =
  | { readonly backend: CloudImageBackend; readonly refusal?: undefined }
  | { readonly backend?: undefined; readonly refusal: string }

// Why a cloud image call cannot be made. One sentence per missing piece, in the order a reader would fix them. The last
// one is absent when the caller has read the provider's terms and said so, because then it is not missing.
const NO_GATE =
  "no cloud image call is made: the payload would leave the machine without the egress gate D13 requires, and the gate " +
  "(packages/micromanager/src/egress.ts) is the plugin's — @omacode/micromanager depends on @omacode/artifact, so " +
  "importing it here would be a cycle, and a second gate in this package would be a second answer to whether a payload " +
  "may leave"
const NO_BUDGET = "no budget can be enforced before the artifact daemon's ledger (B6), so a spend here would be unmetered"
const NO_TERMS = "the provider's terms are not recorded, so what it may do with a prompt or a picture is unknown (D18)"

// Construct the cloud backend, or the reason there is none. The only outcome that carries a backend is a configured key,
// and there every call refuses; there is no configuration in this round under which a picture is fetched from a host.
export function cloudImageBackend(options: CloudImageOptions = {}): CloudImageSetup {
  // No key, no backend: a local-only install should not even hold the shape of a remote render. The key's name is in the
  // sentence precisely because that is the only thing a user needs from it, never its value.
  if (!options.apiKey) {
    return { refusal: `no cloud image backend without an API key (${CLOUD_IMAGE_KEY_ENV})` }
  }
  const refusal = [NO_GATE, NO_BUDGET, ...(options.terms ? [] : [NO_TERMS])].join("; ")
  return {
    backend: {
      name: "cloud",
      available: false,
      refusal,
      ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
      ...(options.terms !== undefined ? { terms: options.terms } : {}),
      async generate(): Promise<CloudImageRefusal> {
        return { ok: false, refused: refusal }
      },
    },
  }
}
