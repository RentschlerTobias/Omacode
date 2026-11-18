// Decision backends per node (design.md §20): the cloud decision client, the local GLiNER decision server, Open-Jev,
// or rules. The decider has exactly two modes, "local" and "cloud" (D11): the mode decides the class of backend a
// node uses, and `default`/`nodes` only name a backend per node within what the mode allows. All speak the same wire
// format, so one client (src/decider.ts) serves them; only URL, model and key differ.
//
// In cloud mode every node may ask the cloud, but only for a session that opted in (A2-T5). The opt-in is a value of
// the session, not of the job or the machine: a session that has not opted in never reaches the egress gate at all,
// its decisions are answered on this machine, and the journal says so. The guards need a second, explicit answer for
// that session, and a sensitive payload cannot be overridden at all (src/egress.ts).
//
// Every decision is journalled here, with the state, the questions and the answers (A2-T2b). A payload for another
// machine passes the egress gate inside that client (src/egress.ts), so the entry also carries the redacted text that
// left and the gate's verdict.

import { randomUUID } from "node:crypto"

import { serviceToken, serviceUrl } from "@omacode/core/services"

import { RULEBOOK_VERSION } from "./catalog.ts"
import { EgressRefused, summary, unredactableText, type EgressOptions, type EgressSummary } from "./egress.ts"
import { cloudApiKey, DecisionClient, type AskContext, type Decision, type Question } from "./decider.ts"
import { record } from "./journal.ts"
import { findTool } from "./which.ts"

export type BackendName = "cloud" | "gliner" | "openjev" | "rules"
export type DeciderMode = "local" | "cloud"

// The per-session opt-in for cloud asks (A2-T5). src/preview.ts CloudOptIn holds the memory and the waiting form; the
// plugin gives it a channel to the session's micromanager. Without one — a CLI run, the runner's headless loop — no
// session is asked and the cloud is not used, rather than sending something nobody opted in to.
export interface ConsentState {
  readonly allow: boolean // this session may use the cloud
  readonly guards: boolean // and its guard questions may go too (the explicit per-session override)
  readonly why: string // for the journal
}

export interface CloudConsent {
  allows(session: string | undefined, job?: string): Promise<ConsentState>
}

// An asker is anything a node can be answered by. The context is what the egress gate needs (which node asks, for which
// session); an asker that has no use for it ignores it, as the rules backend and every test double does.
export interface Asker {
  ask(state: string, questions: Record<string, Question>, context?: AskContext): Promise<Decision>
}

export interface BackendConfig {
  readonly mode: DeciderMode // "local" (the default, D21) or "cloud"; there is no hybrid
  readonly default: BackendName // the backend of a node `nodes` does not name; the mode still bounds it
  readonly nodes: Readonly<Record<string, BackendName>> // node -> backend, e.g. { G0: "gliner" }
  readonly shadow?: BackendName // answers in parallel, journaled only
  readonly urls: Readonly<Partial<Record<Exclude<BackendName, "rules">, string>>>
}

// Guards start on GLiNER, everything else follows the mode: the cloud client in "cloud", and in "local" the cloud
// default is demoted to the local chain. G0 stays on this machine, in either mode, unless its session overrides that.
export const DEFAULT_BACKENDS: BackendConfig = {
  mode: "local",
  default: "cloud",
  nodes: { G0: "gliner", "G0.injection": "gliner", G: "gliner" },
  urls: {
    cloud: "https://api.typesafe.ai/v1/systemone",
    // The container hands its own address in (@omacode/core/services); on a desktop this is the fixed port.
    gliner: `${serviceUrl("decider")}/v1/systemone`,
    openjev: "http://127.0.0.1:8782/v1/systemone",
  },
}

const LOCAL: ReadonlySet<BackendName> = new Set(["gliner", "openjev", "rules"])
// The guard nodes: injection, harmful and sensitive on a job's or task's text (G0) and the same guards on the text a
// worker reads (G0.injection; design.md §14 calls the whole node G). They stay on this machine in both modes unless the
// session's user overrode that for that session alone (A2-T5), and no other node's opt-in carries them along.
const GUARD_NODES = new Set(["G0", "G0.injection", "G"])

export class RulesBackend implements Asker {
  // Answers nothing: every caller falls back to its code default, as without a decision client.
  async ask(): Promise<Decision> {
    return { answers: {}, model: "rules", latencyMs: 0 }
  }
}

// The key belongs to the cloud client, so only "cloud" mode reads it (A2-T2): a local-mode start touches neither
// JEV_API_KEY nor the keyring. `read` is the seam a test uses to prove that nothing is touched.
export function cloudKey(config: BackendConfig, read: () => string | undefined = cloudApiKey): string | undefined {
  return config.mode === "cloud" ? read() : undefined
}

// The one construction site of the cloud client (D19). Local mode, no key and no cloud URL each mean "no client",
// and none of them reads a key or a cloud URL from anywhere else. The gate travels with the client (A2-T6): a caller
// without a confirm function builds a client that can reach nothing at all.
export function cloudClient(config: BackendConfig, key: string | undefined, fetcher?: typeof fetch, egress?: EgressOptions): DecisionClient | undefined {
  if (config.mode !== "cloud" || !key) return undefined
  const url = config.urls.cloud
  if (!url) return undefined
  return new DecisionClient(key, { url, fetch: fetcher, ...(egress ? { egress } : {}) })
}

// A backend exists only where an asker was built. Open-Jev is optional and off when its server is not installed, so
// the backend list names the reason (backendNotes) instead of silently leaving a hole in the fallback chain.
//
// Every client built here carries the same gate. The local servers are loopback URLs, so the gate is not consulted for
// them; a "local" server named by a LAN or public address is remote, and then it is previewed and confirmed like the
// cloud one instead of leaving unremarked.
export function makeAskers(
  config: BackendConfig,
  key: string | undefined,
  fetcher?: typeof fetch,
  installed: (name: string) => boolean = (name) => findTool(name) !== undefined,
  egress?: EgressOptions,
): Partial<Record<BackendName, Asker>> {
  const out: Partial<Record<BackendName, Asker>> = { rules: new RulesBackend() }
  const cloud = cloudClient(config, key, fetcher, egress)
  if (cloud) out.cloud = cloud
  // Local servers take any key, except the container's, which wants its token; their timeout is short so a dead server
  // costs little.
  // GLiNER answers three guards in about 0.4 s on the CPU; 5 s leaves room for a loaded machine.
  if (config.urls.gliner) out.gliner = new DecisionClient(serviceToken() ?? "local", { url: config.urls.gliner, model: "gliner", timeoutMs: 5000, fetch: fetcher, ...(egress ? { egress } : {}) })
  // An Open-Jev server is a Python console script: installed means that program is on PATH, the same test the plugin
  // uses for any local tool it did not place itself (src/which.ts).
  if (config.urls.openjev && installed("openjev")) out.openjev = new DecisionClient("local", { url: config.urls.openjev, model: "openjev", timeoutMs: 5000, fetch: fetcher, ...(egress ? { egress } : {}) })
  return out
}

// A decider that can reach nothing (src/runner.ts without a decision model): rules only, no URL, so no client is built
// and the egress gate is never even consulted.
export function rulesDecider(journal: (entry: Record<string, unknown>) => void): Decider {
  return new Decider({ mode: "local", default: "rules", nodes: {}, urls: {} }, { rules: new RulesBackend() }, journal)
}

// Why a backend is off, in one line, for the plugin's start log: a missing optional server is a state to state.
export function backendNotes(
  config: BackendConfig,
  installed: (name: string) => boolean = (name) => findTool(name) !== undefined,
): string[] {
  const notes: string[] = []
  if (config.urls.openjev && !installed("openjev")) {
    notes.push("openjev: no Open-Jev server installed here (no `openjev` on PATH), so the local backend is off")
  }
  if (config.mode === "cloud" && !config.urls.cloud) notes.push("cloud mode, but no cloud URL is configured: every question goes to the user")
  return notes
}

export interface Asked {
  readonly id: string // journal id; labels refer to it
  readonly backend: BackendName
  readonly decision: Decision
  readonly error?: string // the backend that should have answered failed; rules answered instead
}

export interface AskOptions {
  readonly localOnly?: boolean // a sensitive job: no cloud backend
  readonly job?: string
  readonly task?: string
  readonly session?: string // whose ask it is: the cloud opt-in and the preview of a cloud send wake that session's micromanager
  // Only the cloud client may answer this node. The permission path uses it: A2b exports permission cases for the local
  // model and measures them (npm run bench), but the routing that would let the local model answer them has not flipped.
  // With no cloud asker the rules answer nothing and the caller keeps its own default.
  readonly cloudAnswers?: boolean
  // A permission case: the request itself, journalled beside the text it sent, so the case can be reproduced (A2-T2b).
  readonly request?: Record<string, unknown>
}

export class Decider {
  readonly #config: BackendConfig
  readonly #askers: Partial<Record<BackendName, Asker>>
  readonly #journal: (entry: Record<string, unknown>) => void
  readonly #consent?: CloudConsent

  constructor(
    config: BackendConfig,
    askers: Partial<Record<BackendName, Asker>>,
    journal: (entry: Record<string, unknown>) => void = record,
    consent?: CloudConsent,
  ) {
    this.#config = config
    this.#askers = askers
    this.#journal = journal
    this.#consent = consent
  }

  // The backend a node uses: its configured one, kept local when it has to be, rules when nothing else is there.
  // This is the mode's answer, before any per-session consent: ask() asks the session and falls back when it has not
  // opted in.
  backendFor(node: string, localOnly = false, guards = false): BackendName {
    const wanted = this.#config.nodes[node] ?? this.#config.default
    // Local mode demotes a cloud override to the local chain: nothing leaves the machine there (D11, D21). The
    // guards stay local in cloud mode too unless this session overrode that, and a local-only job never sends anything.
    const local = this.#config.mode === "local" || localOnly || (GUARD_NODES.has(node) && !guards)
    if (!local) return this.#askers[wanted] ? wanted : "rules"
    const chain: BackendName[] = LOCAL.has(wanted) ? [wanted, "gliner", "openjev", "rules"] : ["gliner", "openjev", "rules"]
    return chain.find((b) => this.#askers[b] !== undefined) ?? "rules"
  }

  async ask(node: string, state: Record<string, unknown>, questions: Record<string, Question>, options: AskOptions = {}): Promise<Asked> {
    const id = randomUUID()
    const text = JSON.stringify(state)
    // The backend the mode names, and — for the cloud — the session's opt-in. A session that has not opted in never
    // reaches the egress gate: it is answered on this machine and the journal says why (A2-T5). A guard node's
    // configured backend is local, so only the session's explicit guard answer can take it to the cloud.
    const guard = GUARD_NODES.has(node)
    const modeCloud = this.#config.mode === "cloud" && !options.localOnly && this.#askers.cloud !== undefined
    const cloudWanted = modeCloud && (options.cloudAnswers || guard || this.backendFor(node, options.localOnly, true) === "cloud")
    let consent: ConsentState | undefined
    let overridden: string | undefined
    let backend: BackendName
    if (cloudWanted) {
      consent = this.#consent
        ? await this.#consent.allows(options.session, options.job)
        : { allow: false, guards: false, why: "no channel to ask for a cloud opt-in, so the decision stays local" }
      if (guard) {
        // The guards need the session's second answer, and an unredactable payload cannot be overridden at all: it stays
        // on this machine even for a session whose user let the guards go (A2-T5). An unredactable payload is one that
        // carries a `sensitive` guard flag, or a nontrivial text the redaction left untouched; the gate marks it the
        // same way, and this path agrees before any preview.
        const blocked = unredactableText(text)
        overridden = !consent.allow
          ? consent.why
          : !consent.guards
            ? "the guards stay local in this session"
            : blocked.unredactable
              ? `the guard override is refused: ${blocked.why}`
              : undefined
        backend = overridden === undefined ? "cloud" : this.backendFor(node, true)
      } else {
        // The permission path keeps its own default when the session has not opted in: A2b measures the local model on
        // permission cases, but the gate has not passed (cloudAnswers), so rules answer nothing rather than guessing.
        backend = consent.allow ? "cloud" : options.cloudAnswers ? "rules" : this.backendFor(node, true)
      }
    } else {
      backend = options.cloudAnswers ? "rules" : this.backendFor(node, options.localOnly)
    }
    const context: AskContext = { node, ...(options.job ? { job: options.job } : {}), ...(options.task ? { task: options.task } : {}), ...(options.session ? { session: options.session } : {}) }
    const shadowName = this.#config.shadow
    // Shadow mode is the label factory for the local model (D19): in cloud mode the local backend answers beside the
    // cloud one and is only journaled. In local mode nothing may leave the machine, so there is no second request. A
    // cloud-only node has no shadow either: the local model was never measured on it.
    const shadowAllowed = this.#config.mode === "cloud" && !options.cloudAnswers && shadowName && shadowName !== backend && this.#askers[shadowName] && (LOCAL.has(shadowName) || !options.localOnly)
    const shadow = shadowAllowed ? this.#askers[shadowName]!.ask(text, questions, context).catch((err: unknown) => err as Error) : undefined
    let decision: Decision
    let error: string | undefined
    let refused: EgressSummary | undefined
    try {
      decision = await this.#askers[backend]!.ask(text, questions, context)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      // A cloud call the egress gate kept local did not fail: it never happened, and the journal says which of the two.
      if (err instanceof EgressRefused) refused = summary(err.outcome)
      decision = await new RulesBackend().ask()
    }
    const shadowResult = shadow ? await shadow : undefined
    // One entry kind for every decision ("decision"), with what A2-T2b needs to reproduce a permission case: the mode,
    // the request, the text that actually left (redacted), and the gate's verdict. A2-T5 adds what the session allowed
    // and whether any text left at all, so a decision that stayed home is legible as such. A local answer has no `sent`
    // and no `egress`: nothing left the machine.
    this.#journal({
      kind: "decision",
      id,
      node,
      job: options.job,
      task: options.task,
      mode: this.#config.mode,
      backend: error ? "rules" : backend,
      rulebook: RULEBOOK_VERSION,
      sentText: decision.sent !== undefined,
      error,
      state,
      questions,
      answers: decision.answers,
      model: decision.model,
      latencyMs: decision.latencyMs,
      ...(options.request ? { request: options.request } : {}),
      ...(consent ? { consent: overridden ?? (consent.allow ? (consent.guards ? "cloud+guards" : "cloud") : consent.why) } : {}),
      ...(decision.sent !== undefined ? { sent: decision.sent } : {}),
      ...((decision.egress ?? refused) ? { egress: decision.egress ?? refused } : {}),
      ...(shadowResult && shadowName
        ? shadowResult instanceof Error
          ? { shadow: { backend: shadowName, error: shadowResult.message } }
          : { shadow: { backend: shadowName, answers: shadowResult.answers, latencyMs: shadowResult.latencyMs } }
        : {}),
    })
    return { id, backend: error ? "rules" : backend, decision, error }
  }
}

// A label for a journaled decision: the user's answer, an override, or an outcome observed later (design.md §15).
export function label(
  decisionId: string,
  question: string,
  value: string | number,
  source: "user" | "user_override" | "outcome" | "planning_answer",
  journal: (entry: Record<string, unknown>) => void = record,
): void {
  journal({ kind: "label", decision: decisionId, question, value, source })
}
