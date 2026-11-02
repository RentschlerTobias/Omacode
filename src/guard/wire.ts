import { record } from "../journal.ts"
import { mapStrings, PLACEHOLDER_NOTE, requestTexts, restoreResponse, scanNames, useVault, Vault, type NameSettings } from "../redact.ts"

export interface GuardContextHookInput {
  sessionID?: string
  agent?: string
  messages?: unknown
  prompt?: { text?: string }
  system?: { type: string; text: string }[]
  tools?: Record<string, unknown>
  model?: { providerID?: string; id?: string }
}

export interface HttpResponseEvent {
  readonly sessionID?: string
  readonly kind?: string
  response: Response
}

export interface GuardDeps {
  getVault: () => Vault | undefined
  getNames: () => NameSettings | undefined
  shapeContext?: (input: GuardContextHookInput) => Promise<void>
  log?: (level: "info" | "warn" | "error", message: string) => void
}

const namesDown = new Map<number, number>()

export async function redactRequest(input: GuardContextHookInput, vault: Vault, names?: NameSettings, log?: (level: "info" | "warn" | "error", message: string) => void): Promise<void> {
  if (names) {
    const key = 0
    try {
      await scanNames(vault, requestTexts(input.messages, input.system), names)
      namesDown.set(key, 0)
    } catch (err) {
      const last = namesDown.get(key) ?? 0
      if (Date.now() - last > 600_000) {
        namesDown.set(key, Date.now())
        record({ kind: "redact.names-unavailable", sessionID: input.sessionID, error: String(err) })
        log?.("warn", `names and addresses were not checked: ${String(err)}`)
      }
    }
  }
  if (Array.isArray(input.messages)) mapStrings(input.messages, (s) => vault.restore(s, (kind) => kind !== "secret"))
  if (Array.isArray(input.messages)) mapStrings(input.messages, (s) => vault.redact(s))
  if (Array.isArray(input.system)) {
    for (const p of input.system) if (typeof p.text === "string") p.text = vault.restore(p.text, (kind) => kind !== "secret")
    for (const p of input.system) if (typeof p.text === "string") p.text = vault.redact(p.text)
    input.system.push({ type: "text", text: PLACEHOLDER_NOTE })
  }
}

export function installGuard(ctx: any, deps: GuardDeps): void {
  ctx.session.hook("context", async (input: GuardContextHookInput) => {
    if (deps.shapeContext) await deps.shapeContext(input)
    const vault = deps.getVault()
    if (vault) await redactRequest(input, vault, deps.getNames(), deps.log)
  })
  ctx.session.hook("compaction", async (input: GuardContextHookInput) => {
    const vault = deps.getVault()
    if (vault) await redactRequest(input, vault, deps.getNames(), deps.log)
  })
  ctx.session.hook("generate", async (input: GuardContextHookInput) => {
    const vault = deps.getVault()
    if (vault) await redactRequest(input, vault, deps.getNames(), deps.log)
  })
  ctx.session.hook("title", async (input: GuardContextHookInput) => {
    const vault = deps.getVault()
    if (vault) await redactRequest(input, vault, deps.getNames(), deps.log)
  })
  try {
    ctx.session.hook("http.response", (event: HttpResponseEvent) => {
      const vault = deps.getVault()
      if (vault) event.response = restoreResponse(event.response, vault)
    })
  } catch (err) {
    deps.log?.("warn", `response restore hook unavailable: ${String(err)}`)
  }
}

export function defaultDeps(): GuardDeps {
  return {
    getVault: () => undefined,
    getNames: () => undefined,
  }
}
