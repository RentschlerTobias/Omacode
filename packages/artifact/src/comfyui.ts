// The shared ComfyUI client (B5-T2): `/object_info`, `/upload/image`, `/prompt`, `/history`, `/view` and `/ws`, over
// `fetch` alone. No package is added for HTTP or for WebSocket access; Node has both, and this file uses nothing else.
//
// The client answers about a server the way the rest of the artifact package answers about a file: a call returns a
// value — an answer or a refusal — and never throws. A timeout, a 500, a connection refused, a body that is not JSON
// and a workflow the server rejected are all the same kind of thing to a caller that is deciding what to report, and a
// `try` block around every request would make the adapter's own failures indistinguishable from the server's.
//
// The base URL is loopback by default. A ComfyUI on another machine is allowed, but never silently: it is declared in
// code with `allowRemote: true` beside its URL (`new ComfyClient({ url, allowRemote: true })`), and `images.json` has no
// field that can reach either. A remote render is a decision the caller makes, not one a spec smuggles in.
//
// The workflow a caller hands `prompt` is data. It is serialised as JSON into the request body; no part of it becomes a
// command, a path the client resolves, or a URL. The client cannot tell a checkpoint name from a prompt — that is the
// adapter's job — but it guarantees that whatever the graph says stays inside the body of one POST.
//
// Progress arrives on `/ws` as ComfyUI's own messages, normalised to `{ id, node, value, max }` so a caller can show a
// bar without knowing the server's wire format. `/ws` is used for progress only; completion is read from `/history`,
// which is also what `watch` polls when no WebSocket client is available. On this repository's Node the global
// `WebSocket` exists, so `/ws` is the default; a host without one falls back to polling and says so through
// `watchTransport`, rather than failing a render for the absence of a progress bar.

import { randomUUID } from "node:crypto"

export const COMFYUI_DEFAULT_URL = "http://127.0.0.1:8188"

// One picture ComfyUI knows by name: what `/view` downloads and what `/upload/image` answers with.
export interface ComfyImage {
  readonly filename: string
  readonly subfolder: string
  readonly type: string
}

// What `/prompt` queued. The number is the server's queue position at the moment it accepted the graph.
export interface ComfyQueued {
  readonly id: string
  readonly number?: number
}

// A `/history` entry, flattened to the three facts a caller acts on. `pending` means the server has not finished yet
// (an empty history); `failed` is a job that finished wrong, which is an answer and not a transport refusal.
export interface ComfyHistory {
  readonly id: string
  readonly pending: boolean
  readonly failed: boolean
  readonly images: readonly ComfyImage[]
  readonly error?: string
}

// What a caller's bar reads. `node` is the graph node the server is executing, as a string, because node ids are keys
// and a caller showing the value does not need to know whether this server used a number.
export interface ComfyProgress {
  readonly id: string
  readonly node: string
  readonly value: number
  readonly max: number
}

// A refusal rather than a throw. `status` is present when the server answered with an HTTP status; it is absent for a
// timeout, a refused connection and a body this client could not read.
export interface ComfyRefusal {
  readonly ok: false
  readonly refused: string
  readonly status?: number
}

export type ComfyAnswer<T> = { readonly ok: true; readonly value: T } | ComfyRefusal

export interface ComfyOptions {
  // The server's base URL. Loopback by default; a path prefix is kept, a query or fragment is refused.
  readonly url?: string
  // The deliberate half of a remote render. Without it a non-loopback URL is a refusal on every call, and the sentence
  // says which option would have allowed it.
  readonly allowRemote?: boolean
  // How long one HTTP request may take. A generation runs as a job on the server, so the wait for a result is `watch`'s
  // timeout and not this one.
  readonly timeoutMs?: number
  // How often `watch` asks `/history` while it waits. The default is a second: a bar driven by `/ws` is immediate, and a
  // history poll is a cheap request that also works when there is no WebSocket.
  readonly pollMs?: number
  // How long `watch` waits for a job to finish. Ten minutes is short for a big model and long for a server that has
  // forgotten the job; a caller rendering a film can raise it per watch.
  readonly watchTimeoutMs?: number
  // A WebSocket implementation, or `false` to use polling deliberately. Absent means the global `WebSocket` when this
  // host has one. This is a capability the caller can narrow for a machine or a test, not a dependency.
  readonly webSocket?: WsConstructor | false
  readonly fetch?: typeof fetch
}

// The small part of the WebSocket interface this client uses. Written out rather than imported from a DOM lib, so the
// package keeps compiling with `types: ["node"]` and a host without the global still gets a client.
export interface WsMessageEvent {
  readonly data: unknown
}

export interface WsSocket {
  onopen: (() => void) | null
  onmessage: ((event: WsMessageEvent) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  close(): void
}

export type WsConstructor = new (url: string) => WsSocket

export interface ComfyWatchOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 1_000
const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const reason = (error: unknown): string => {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

// A refusal that names the client, so a caller can put it beside a file's error without guessing who answered.
const refusal = (why: string, status?: number): ComfyRefusal => ({
  ok: false,
  refused: `comfyui: ${why}`,
  ...(status !== undefined ? { status } : {}),
})

// A body is not worth echoing whole into a report; the beginning is enough to see whether it was HTML, JSON or a
// reverse proxy's page.
const clip = (text: string, limit = 240): string => (text.length > limit ? `${text.slice(0, limit)}…` : text)

// Loopback means this machine. `localhost`, the IPv4 loopback block, IPv6's `::1` and an IPv4-mapped `::1` all count;
// `0.0.0.0` does not, because it is an address to bind, not one to connect to.
function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host.startsWith("::ffff:127.")
  )
}

function webSocketConstructor(value: ComfyOptions["webSocket"]): WsConstructor | undefined {
  if (value === false) return undefined
  if (value !== undefined) return value
  const global = (globalThis as { WebSocket?: unknown }).WebSocket
  return typeof global === "function" ? (global as WsConstructor) : undefined
}

// A sleeping promise that a test can drive with real time. The watch loop uses it between history polls; there is no
// timer left behind when the loop returns, because the loop does not start a new one until it asks again.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class ComfyClient {
  readonly url: string
  // Why this client refuses every call before it makes one, or undefined when the base URL is usable. A caller that
  // wants to fail early reads this; a caller that calls anyway gets the same sentence as a value.
  #refusal: string | undefined = undefined
  // How `watch` follows a job on this host: `/ws` for progress, or `/history` polling when there is no WebSocket.
  readonly watchTransport: "ws" | "poll"

  get refusal(): string | undefined {
    return this.#refusal
  }

  readonly #root: string
  readonly #timeoutMs: number
  readonly #pollMs: number
  readonly #watchTimeoutMs: number
  readonly #fetch: typeof fetch
  readonly #socket: WsConstructor | undefined
  readonly #clientId: string

  constructor(options: ComfyOptions = {}) {
    const stated = options.url ?? COMFYUI_DEFAULT_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#watchTimeoutMs = options.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS
    this.#fetch = options.fetch ?? fetch
    this.#socket = webSocketConstructor(options.webSocket)
    this.#clientId = randomUUID()
    this.watchTransport = this.#socket === undefined ? "poll" : "ws"

    let parsed: URL
    try {
      parsed = new URL(stated)
    } catch {
      this.url = stated
      this.#refusal = `the base URL ${shown(stated)} is not a URL`
      this.#root = ""
      return
    }
    this.url = stated
    this.#root = stated.replace(/\/+$/, "")

    const invalid = (why: string): void => {
      this.#refusal = why
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      invalid(`the base URL ${shown(stated)} must be http or https, not ${parsed.protocol.replace(":", "")}`)
      return
    }
    if (parsed.username || parsed.password) {
      invalid(`the base URL ${shown(stated)} carries credentials; a ComfyUI server is addressed, not logged into`)
      return
    }
    if (parsed.search || parsed.hash) {
      invalid(`the base URL ${shown(stated)} must not carry a query or a fragment`)
      return
    }
    if (!loopback(parsed.hostname) && options.allowRemote !== true) {
      invalid(
        `${parsed.host} is not loopback; a remote ComfyUI is declared with allowRemote: true beside its URL, and no images.json can declare it`,
      )
    }
  }

  // The server's node catalogue. The answer is the JSON object as the server wrote it; this client does not pretend to
  // understand every node type, and B5-T4 is what will read a checkpoint list out of it.
  async objectInfo(): Promise<ComfyAnswer<Record<string, unknown>>> {
    const response = await this.#request("/object_info", { method: "GET" })
    if (!response.ok) return response
    const body = await this.#json(response.value)
    if (!body.ok) return body
    if (!isRecord(body.value)) return refusal(`/object_info answered ${shown(body.value)}, not an object`)
    return { ok: true, value: body.value }
  }

  // One file into ComfyUI's input directory. The name is a name, not a path: the server chooses the directory, and a
  // caller that needs a subdirectory uses the server's own field rather than a slash this client would have to trust.
  async uploadImage(input: { readonly name: string; readonly bytes: Uint8Array }): Promise<ComfyAnswer<ComfyImage>> {
    if (!input.name || input.name === "." || input.name === ".." || /[/\\]/.test(input.name)) {
      return refusal(`an upload name must be one file name, got ${shown(input.name)}`)
    }
    if (input.bytes.byteLength === 0) return refusal(`the upload ${shown(input.name)} has no bytes`)
    const form = new FormData()
    // A copy keeps the Blob's bytes from outliving the caller's buffer, and satisfies the Node types, which do not take
    // a possibly shared array as a Blob part.
    const bytes = new Uint8Array(input.bytes.byteLength)
    bytes.set(input.bytes)
    form.append("image", new Blob([bytes]), input.name)
    form.append("type", "input")
    form.append("overwrite", "true")

    const response = await this.#request("/upload/image", { method: "POST", body: form })
    if (!response.ok) return response
    const body = await this.#json(response.value)
    if (!body.ok) return body
    const image = imageOf(body.value)
    if (image === undefined) return refusal(`/upload/image answered ${shown(body.value)} without a file name`)
    return { ok: true, value: image }
  }

  // One workflow, queued. The graph is the body; it is never a command line and no part of it is resolved here. A server
  // that answers 200 with node errors has refused the graph, which is a refusal value like a 400 would be.
  async prompt(workflow: Readonly<Record<string, unknown>>): Promise<ComfyAnswer<ComfyQueued>> {
    let body: string | undefined
    try {
      body = JSON.stringify({ prompt: workflow, client_id: this.#clientId })
    } catch (error) {
      return refusal(`the workflow is not JSON data: ${reason(error)}`)
    }
    if (body === undefined) return refusal("the workflow is not JSON data")

    const response = await this.#request("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    if (!response.ok) return response
    const answer = await this.#json(response.value)
    if (!answer.ok) return answer
    if (!isRecord(answer.value)) return refusal(`/prompt answered ${shown(answer.value)}, not an object`)
    const id = answer.value["prompt_id"]
    const nodeErrors = answer.value["node_errors"]
    if (isRecord(nodeErrors) && Object.keys(nodeErrors).length > 0) {
      return refusal(`the server refused the workflow: ${clip(JSON.stringify(nodeErrors))}`)
    }
    if (typeof id !== "string" || !id) {
      const error = answer.value["error"]
      const said = isRecord(error) && typeof error["message"] === "string" ? `: ${error["message"]}` : ""
      return refusal(`/prompt did not queue the workflow${said}`)
    }
    const number = answer.value["number"]
    return { ok: true, value: { id, ...(typeof number === "number" ? { number } : {}) } }
  }

  // One job's place in the history. `{}` is how ComfyUI says "not finished", so it is a pending answer and not a
  // refusal; a `status_str` of "error" is a finished job that failed, with the exception message when there is one.
  async history(id: string): Promise<ComfyAnswer<ComfyHistory>> {
    if (!id) return refusal("a history id must not be empty")
    let path: string
    try {
      path = `/history/${encodeURIComponent(id)}`
    } catch {
      return refusal(`the history id ${shown(id)} cannot be put in a URL`)
    }
    const response = await this.#request(path, { method: "GET" })
    if (!response.ok) return response
    const body = await this.#json(response.value)
    if (!body.ok) return body
    if (!isRecord(body.value)) return refusal(`/history/${id} answered ${shown(body.value)}, not an object`)
    const entry = body.value[id]
    if (entry === undefined) return { ok: true, value: { id, pending: true, failed: false, images: [] } }
    if (!isRecord(entry)) return refusal(`/history/${id} answered ${shown(entry)}, not an entry`)

    const status = isRecord(entry["status"]) ? entry["status"] : undefined
    const statusStr = typeof status?.["status_str"] === "string" ? status["status_str"] : undefined
    const failed = statusStr === "error"
    const images = imagesOf(entry["outputs"])
    const completed = status?.["completed"] === true
    const pending = !failed && !completed && statusStr !== "success" && images.length === 0
    const error = failed ? errorOf(status) : undefined
    return {
      ok: true,
      value: {
        id,
        pending,
        failed,
        images,
        ...(error !== undefined ? { error } : {}),
      },
    }
  }

  // One produced file's bytes. A 200 with a body that is not a picture is still bytes here; the adapter that knows what
  // it asked for is the one that decides whether the picture is usable.
  async view(input: ComfyImage): Promise<ComfyAnswer<Uint8Array>> {
    const query = new URLSearchParams({
      filename: input.filename,
      subfolder: input.subfolder,
      type: input.type,
    })
    const response = await this.#request(`/view?${query.toString()}`, { method: "GET" })
    if (!response.ok) return response
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.value.arrayBuffer())
    } catch (error) {
      return refusal(`/view could not be read: ${reason(error)}`)
    }
    if (bytes.byteLength === 0) return refusal(`/view returned an empty file for ${shown(input.filename)}`)
    return { ok: true, value: bytes }
  }

  // Follow one job. Progress comes from `/ws` when the host has a WebSocket, and completion from `/history` either way;
  // without a WebSocket the same loop polls and the bar simply has no intermediate values. The answer is the history
  // entry, so a failed job is `{ failed: true }` and not a refusal.
  async watch(
    id: string,
    onProgress: (progress: ComfyProgress) => void,
    options: ComfyWatchOptions = {},
  ): Promise<ComfyAnswer<ComfyHistory>> {
    if (!id) return refusal("a watch id must not be empty")
    if (this.refusal !== undefined) return refusal(this.refusal)
    const timeoutMs = options.timeoutMs ?? this.#watchTimeoutMs
    const started = Date.now()
    const socket = this.#openSocket(id, onProgress)

    try {
      for (;;) {
        if (options.signal?.aborted) return refusal(`the watch of ${shown(id)} was cancelled`)
        const answer = await this.history(id)
        if (!answer.ok) return answer
        if (!answer.value.pending) return answer
        const left = timeoutMs - (Date.now() - started)
        if (left <= 0) return refusal(`job ${shown(id)} did not finish within ${timeoutMs} ms`)
        await sleep(Math.min(this.#pollMs, left))
      }
    } finally {
      try {
        socket?.close()
      } catch {
        // A socket that is already closed has nothing to add to the answer.
      }
    }
  }

  // The `/ws` URL of this server. Built from the base URL rather than from a job path, so the only address this client
  // ever opens is the one it was constructed with.
  #wsUrl(): string {
    return `${this.#root.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(this.#clientId)}`
  }

  // Best-effort progress. A WebSocket that cannot open, closes early or speaks something this client does not know is
  // not a failed job: the history poll is what decides, and the bar is an ornament on top of it.
  #openSocket(id: string, onProgress: (progress: ComfyProgress) => void): { close(): void } | undefined {
    if (this.#socket === undefined) return undefined
    try {
      const socket = new this.#socket(this.#wsUrl())
      socket.onmessage = (event: WsMessageEvent): void => {
        const text =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Uint8Array
              ? new TextDecoder().decode(event.data)
              : ""
        if (!text) return
        let message: unknown
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (!isRecord(message) || message["type"] !== "progress") return
        const data = message["data"]
        if (!isRecord(data) || data["prompt_id"] !== id) return
        const value = data["value"]
        const max = data["max"]
        const node = data["node"]
        if (typeof value !== "number" || typeof max !== "number") return
        try {
          onProgress({ id, node: node === undefined || node === null ? "" : String(node), value, max })
        } catch {
          // A caller's bar is not the render. Swallowing its mistake keeps the job's answer coming.
        }
      }
      socket.onerror = (): void => {}
      socket.onclose = (): void => {}
      return { close: () => socket.close() }
    } catch {
      return undefined
    }
  }

  // One request, one verdict. The timeout covers the response body as well, because `AbortSignal.timeout` aborts the
  // fetch rather than only the headers. A redirect is refused: a server that can send this client to another host would
  // make the loopback/allowRemote decision above meaningless.
  async #request(path: string, init: RequestInit): Promise<ComfyAnswer<Response>> {
    if (this.refusal !== undefined) return refusal(this.refusal)
    let response: Response
    try {
      response = await this.#fetch(`${this.#root}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      return refusal(`${init.method ?? "GET"} ${path} could not reach the server: ${reason(error)}`)
    }
    if (!response.ok) {
      let said = ""
      try {
        said = clip(await response.text())
      } catch {
        said = ""
      }
      return refusal(`${init.method ?? "GET"} ${path}: HTTP ${response.status}${said ? `: ${said}` : ""}`, response.status)
    }
    return { ok: true, value: response }
  }

  async #json(response: Response): Promise<ComfyAnswer<unknown>> {
    try {
      return { ok: true, value: await response.json() }
    } catch (error) {
      return refusal(`the answer is not JSON: ${reason(error)}`)
    }
  }
}

// The three fields of a `/view` reference, when the server wrote them as strings. `subfolder` and `type` have defaults
// because older servers omit them for a file at the root of their output directory.
function imageOf(value: unknown): ComfyImage | undefined {
  if (!isRecord(value)) return undefined
  const filename = value["filename"] ?? value["name"]
  if (typeof filename !== "string" || !filename) return undefined
  const subfolder = value["subfolder"]
  const type = value["type"]
  return {
    filename,
    subfolder: typeof subfolder === "string" ? subfolder : "",
    type: typeof type === "string" && type ? type : "output",
  }
}

// Every picture an entry's `outputs` object names. A node that produced something else — a latent, a mask, a text — is
// simply not a picture here, and a picture without a file name is not one a caller could fetch.
function imagesOf(outputs: unknown): readonly ComfyImage[] {
  if (!isRecord(outputs)) return []
  const images: ComfyImage[] = []
  for (const output of Object.values(outputs)) {
    if (!isRecord(output)) continue
    const list = output["images"]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const image = imageOf(entry)
      if (image !== undefined) images.push(image)
    }
  }
  return images
}

// Why a history entry ended in an error. ComfyUI carries the reason in `status.messages` as `[type, data]` pairs;
// `execution_error` has the exception message, and every other message is ignored rather than turned into prose a person
// cannot act on.
function errorOf(status: Record<string, unknown> | undefined): string | undefined {
  const messages = status?.["messages"]
  if (!Array.isArray(messages)) return undefined
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue
    if (message[0] !== "execution_error" || !isRecord(message[1])) continue
    const text = message[1]["exception_message"]
    if (typeof text === "string" && text) return text
  }
  return undefined
}
