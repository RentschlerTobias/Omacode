// Decision backends per node (design.md §20): the cloud decision client, the local GLiNER decision server, Open-Jev,
// or rules. The decider has exactly two modes, "local" and "cloud" (D11): the mode decides the class of backend a
// node uses, and `default`/`nodes` only name a backend per node within what the mode allows. All speak the same wire
// format, so one client (src/decider.ts) serves them; only URL, model and key differ.

import { randomUUID } from "node:crypto"

import { cloudApiKey, DecisionClient, type Decision, type Question } from "./decider.ts"
import { record } from "./journal.ts"
import { findTool } from "./which.ts"

export type BackendName = "cloud" | "gliner" | "openjev" | "rules"
export type DeciderMode = "local" | "cloud"

export interface Asker {
  ask(state: string, questions: Record<string, Question>): Promise<Decision>
}

export interface BackendConfig {
  readonly mode: DeciderMode // "local" (the default, D21) or "cloud"; there is no hybrid
  readonly default: BackendName // the backend of a node `nodes` does not name; the mode still bounds it
  readonly nodes: Readonly<Record<string, BackendName>> // node -> backend, e.g. { G0: "gliner" }
  readonly shadow?: BackendName // answers in parallel, journaled only
  readonly urls: Readonly<Partial<Record<Exclude<BackendName, "rules">, string>>>
}

// Guards start on GLiNER, everything else follows the mode: the cloud client in "cloud", and in "local" the cloud
// default is demoted to the local chain. G0 never leaves the machine, in either mode.
export const DEFAULT_BACKENDS: BackendConfig = {
  mode: "local",
  default: "cloud",
  nodes: { G0: "gliner", "G0.injection": "gliner", G: "gliner" },
  urls: {
    cloud: "https://api.typesafe.ai/v1/systemone",
    gliner: "http://127.0.0.1:8781/v1/systemone",
    openjev: "http://127.0.0.1:8782/v1/systemone",
  },
}

const LOCAL: ReadonlySet<BackendName> = new Set(["gliner", "openjev", "rules"])
// Nodes whose questions carry user and task text that must never reach the cloud.
const ALWAYS_LOCAL = new Set(["G0", "G0.injection"])

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
// and none of them reads a key or a cloud URL from anywhere else.
export function cloudClient(config: BackendConfig, key: string | undefined, fetcher?: typeof fetch): DecisionClient | undefined {
  if (config.mode !== "cloud" || !key) return undefined
  const url = config.urls.cloud
  if (!url) return undefined
  return new DecisionClient(key, { url, fetch: fetcher })
}

// A backend exists only where an asker was built. Open-Jev is optional and off when its server is not installed, so
// the backend list names the reason (backendNotes) instead of silently leaving a hole in the fallback chain.
export function makeAskers(
  config: BackendConfig,
  key: string | undefined,
  fetcher?: typeof fetch,
  installed: (name: string) => boolean = (name) => findTool(name) !== undefined,
): Partial<Record<BackendName, Asker>> {
  const out: Partial<Record<BackendName, Asker>> = { rules: new RulesBackend() }
  const cloud = cloudClient(config, key, fetcher)
  if (cloud) out.cloud = cloud
  // Local servers take any key; their timeout is short so a dead server costs little.
  // GLiNER answers four guards in about 0.4 s on the CPU; 5 s leaves room for a loaded machine.
  if (config.urls.gliner) out.gliner = new DecisionClient("local", { url: config.urls.gliner, model: "gliner", timeoutMs: 5000, fetch: fetcher })
  // An Open-Jev server is a Python console script: installed means that program is on PATH, the same test the plugin
  // uses for any local tool it did not place itself (src/which.ts).
  if (config.urls.openjev && installed("openjev")) out.openjev = new DecisionClient("local", { url: config.urls.openjev, model: "openjev", timeoutMs: 5000, fetch: fetcher })
  return out
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
}

export class Decider {
  readonly #config: BackendConfig
  readonly #askers: Partial<Record<BackendName, Asker>>
  readonly #journal: (entry: Record<string, unknown>) => void

  constructor(config: BackendConfig, askers: Partial<Record<BackendName, Asker>>, journal: (entry: Record<string, unknown>) => void = record) {
    this.#config = config
    this.#askers = askers
    this.#journal = journal
  }

  // The backend a node uses: its configured one, kept local when it has to be, rules when nothing else is there.
  backendFor(node: string, localOnly = false): BackendName {
    const wanted = this.#config.nodes[node] ?? this.#config.default
    // Local mode demotes a cloud override to the local chain: nothing leaves the machine there (D11, D21). The
    // guards stay local in cloud mode too, and a local-only job never sends anything.
    const local = this.#config.mode === "local" || localOnly || ALWAYS_LOCAL.has(node)
    if (!local) return this.#askers[wanted] ? wanted : "rules"
    const chain: BackendName[] = LOCAL.has(wanted) ? [wanted, "gliner", "openjev", "rules"] : ["gliner", "openjev", "rules"]
    return chain.find((b) => this.#askers[b] !== undefined) ?? "rules"
  }

  async ask(node: string, state: Record<string, unknown>, questions: Record<string, Question>, options: AskOptions = {}): Promise<Asked> {
    const id = randomUUID()
    const backend = this.backendFor(node, options.localOnly)
    const text = JSON.stringify(state)
    const shadowName = this.#config.shadow
    // Shadow mode is the label factory for the local model (D19): in cloud mode the local backend answers beside the
    // cloud one and is only journaled. In local mode nothing may leave the machine, so there is no second request.
    const shadowAllowed = this.#config.mode === "cloud" && shadowName && shadowName !== backend && this.#askers[shadowName] && (LOCAL.has(shadowName) || !(options.localOnly || ALWAYS_LOCAL.has(node)))
    const shadow = shadowAllowed ? this.#askers[shadowName]!.ask(text, questions).catch((err: unknown) => err as Error) : undefined
    let decision: Decision
    let error: string | undefined
    try {
      decision = await this.#askers[backend]!.ask(text, questions)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      decision = await new RulesBackend().ask()
    }
    const shadowResult = shadow ? await shadow : undefined
    this.#journal({
      kind: "decision",
      id,
      node,
      job: options.job,
      task: options.task,
      backend: error ? "rules" : backend,
      error,
      state,
      questions,
      answers: decision.answers,
      model: decision.model,
      latencyMs: decision.latencyMs,
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
