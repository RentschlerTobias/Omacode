// What the provider says it used, next to what the plugin estimates.
//
// The plugin estimates the context's size from its characters (chars / 3.5, src/context/policy.ts). The estimate is a
// guess: a message of JSON in English costs more tokens than the same number of characters of code, and a provider
// that counted its own tokens knows better. When a provider reports its usage (the "usage" field of a chat
// completion), that number is the truth about the last turn, and the compaction trigger should use it.
//
// The report is not a replacement for the estimate: it counts one turn's tokens, while the estimate counts everything
// in the context (the system prompt, the tools, the whole history). So the trigger takes the larger of the two, and
// falls back to the estimate when no provider has reported yet.
//
// The report arrives in the "http.response" hook (src/plugin.ts): the provider's answer, before it is parsed. The body
// is tapped, not read: the host parses it afterwards, so the bytes are copied through a stream that looks for the
// usage on the way and gives the host the same bytes.

export interface ProviderUsage {
  readonly input: number // the tokens the prompt took
  readonly output: number // the tokens the answer took
  readonly total: number // what the provider counted altogether
}

// How many sessions' usage are kept; the oldest goes when there are more.
const REPORTED_SESSIONS = 64

// How much of a body is kept while it is tapped; the usage sits at the end of an answer, so a tail is enough.
const TAPPED_CHARS = 64 * 1024

// The usage a provider's answer carries, whatever shape it has: the OpenAI names (prompt_tokens, completion_tokens),
// the Anthropic names (input_tokens, output_tokens) and the plain ones (input, output). undefined when the answer
// carries none.
export function usageOf(payload: unknown): ProviderUsage | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const body = payload as Record<string, unknown>
  const raw = (body.usage ?? body.token_usage ?? body.usage_metadata) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== "object") return undefined
  const num = (...names: string[]): number => {
    for (const n of names) {
      const v = raw[n]
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
    }
    return 0
  }
  const input = num("input_tokens", "prompt_tokens", "input", "inputTokens", "promptTokens")
  const output = num("output_tokens", "completion_tokens", "output", "outputTokens", "completionTokens")
  const total = num("total_tokens", "total", "totalTokens") || input + output
  if (!input && !output && !total) return undefined
  return { input, output, total }
}

// The usage of the last answer of each session: what the provider counted, so the trigger can use it.
export class ReportedUsage {
  readonly #bySession = new Map<string, ProviderUsage>()

  // What the provider reported for a session, if it reported anything.
  get(sessionID: string): ProviderUsage | undefined {
    return this.#bySession.get(sessionID)
  }

  // The tokens the provider counted for a session: the total of its last answer, or of its last prompt when the answer
  // did not say. undefined when the provider said nothing.
  tokens(sessionID: string): number | undefined {
    const u = this.#bySession.get(sessionID)
    if (!u) return undefined
    return u.total || u.input || u.output
  }

  // What an answer reported.
  record(sessionID: string, usage: ProviderUsage | undefined): void {
    if (!usage) return
    this.#bySession.set(sessionID, usage)
    // The map is a cache of the last answer per session; it does not grow with the length of the session.
    while (this.#bySession.size > REPORTED_SESSIONS) {
      const oldest = this.#bySession.keys().next()
      if (oldest.done) break
      this.#bySession.delete(oldest.value)
    }
  }
}

// The usage in a body: the whole body as JSON, or the last "usage" object in it, which is where a stream puts it.
export function findUsage(body: string): ProviderUsage | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  try {
    const direct = usageOf(JSON.parse(trimmed))
    if (direct) return direct
  } catch {
    // not one JSON document: a stream of events, or a body that is cut short
  }
  // A stream of events (event-stream): the last "usage" object in it is the one the provider counted last.
  let found: ProviderUsage | undefined
  for (const chunk of trimmed.split("\n")) {
    const line = chunk.trim()
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      const u = usageOf(JSON.parse(data))
      if (u) found = u
    } catch {
      // an event that is not JSON
    }
  }
  if (found) return found
  // A body that is not JSON at all but carries the numbers in a "usage" object somewhere: the last one wins.
  const at = trimmed.lastIndexOf('"usage"')
  if (at < 0) return undefined
  const open = trimmed.indexOf("{", at)
  if (open < 0) return undefined
  let depth = 0
  let end = -1
  for (let i = open; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++
    else if (trimmed[i] === "}") {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) return undefined
  try {
    return usageOf(JSON.parse(trimmed.slice(open, end)))
  } catch {
    return undefined
  }
}

// A response whose body is tapped for its usage: the bytes reach the host unchanged, and the usage is found on the
// way. undefined when the response cannot be tapped (no body), so the caller keeps the response as it was.
export function tapResponse(response: Response, onText: (text: string) => void): Response {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let carry = ""
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        carry += decoder.decode(chunk, { stream: true })
        if (carry.length > TAPPED_CHARS) carry = carry.slice(-TAPPED_CHARS)
        controller.enqueue(chunk)
      },
      flush(controller) {
        carry += decoder.decode()
        if (carry) onText(carry)
      },
    }),
  )
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
