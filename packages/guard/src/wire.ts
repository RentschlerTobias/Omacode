import { record } from "@omacode/core/journal"
import { mapStrings, PLACEHOLDER_NOTE, requestTexts, restoreResponse, scanNames, useVault, Vault, type NameSettings } from "./redact.ts"

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

export interface HttpRequestEvent {
  readonly sessionID?: string
  request: Request
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

function modelBody(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return (
    Array.isArray(body.messages) ||
    Array.isArray(body.contents) ||
    body.system !== undefined ||
    body.systemInstruction !== undefined ||
    body.prompt !== undefined ||
    body.input !== undefined ||
    body.instructions !== undefined
  )
}

function allTexts(value: unknown): string[] {
  const out: string[] = []
  mapStrings(value, (s) => {
    out.push(s)
    return s
  })
  return out
}

// Make sure the model knows what the placeholders are, even when no context hook ran (guard used on its own).
function addPlaceholderNote(body: Record<string, any>): void {
  try {
    if (JSON.stringify(body).includes(PLACEHOLDER_NOTE)) return
  } catch {
    return
  }
  if (typeof body.system === "string") {
    body.system = `${body.system}\n\n${PLACEHOLDER_NOTE}`
    return
  }
  if (Array.isArray(body.system)) {
    body.system.push({ type: "text", text: PLACEHOLDER_NOTE })
    return
  }
  if (body.systemInstruction && typeof body.systemInstruction === "object") {
    const parts = (body.systemInstruction as Record<string, any>).parts
    if (Array.isArray(parts)) {
      parts.push({ text: PLACEHOLDER_NOTE })
      return
    }
  }
  if (Array.isArray(body.messages) && body.system === undefined) {
    const system = body.messages.find((m: any) => m && typeof m === "object" && m.role === "system")
    if (system) {
      if (typeof system.content === "string") system.content = `${system.content}\n\n${PLACEHOLDER_NOTE}`
      else if (Array.isArray(system.content)) system.content.push({ type: "text", text: PLACEHOLDER_NOTE })
      else system.content = PLACEHOLDER_NOTE
      return
    }
    body.messages.unshift({ role: "system", content: PLACEHOLDER_NOTE })
  }
}

// The last line before the wire: redact the serialized request body. Provider formats differ, so the body is only
// touched when it looks like a model request; arbitrary tool traffic (form posts, uploads, auth) is left alone.
export async function redactHttpRequest(
  request: Request,
  vault: Vault,
  names?: NameSettings,
  log?: (level: "info" | "warn" | "error", message: string) => void,
  warned: Set<string> = new Set(),
): Promise<Request> {
  try {
    const type = request.headers.get("content-type") ?? ""
    if (!type.toLowerCase().includes("json")) return request
    if (request.headers.get("content-encoding")) {
      if (!warned.has("encoding")) {
        warned.add("encoding")
        log?.("warn", "an outgoing request was compressed and was not checked by the guard")
      }
      return request
    }
    if (!request.body) return request
    const text = await request.clone().text()
    if (!text) return request
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return request
    }
    if (!modelBody(body)) return request
    if (names) {
      try {
        await scanNames(vault, allTexts(body), names)
      } catch (err) {
        if (!warned.has("names")) {
          warned.add("names")
          log?.("warn", `names and addresses were not checked: ${String(err)}`)
        }
      }
    }
    let changed = false
    mapStrings(body, (s) => {
      const next = vault.redact(s)
      if (next !== s) changed = true
      return next
    })
    if (!changed) return request
    addPlaceholderNote(body)
    const headers = new Headers(request.headers)
    headers.delete("content-length")
    return new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      redirect: request.redirect,
      signal: request.signal,
    })
  } catch (err) {
    if (!warned.has("request")) {
      warned.add("request")
      log?.("warn", `an outgoing request could not be checked: ${String(err)}`)
    }
    return request
  }
}

export function installGuard(ctx: any, deps: GuardDeps): void {
  const warned = new Set<string>()
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
    ctx.session.hook("http.request", async (event: HttpRequestEvent) => {
      const vault = deps.getVault()
      if (vault && event?.request) event.request = await redactHttpRequest(event.request, vault, deps.getNames(), deps.log, warned)
    })
  } catch (err) {
    deps.log?.("warn", `request redaction hook unavailable: ${String(err)}`)
  }
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
