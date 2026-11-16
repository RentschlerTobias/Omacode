// A ComfyUI server small enough to own in a test (B5-T2/B5-T1). It answers the six routes the client uses — object info,
// upload, prompt, history, view and the `/ws` upgrade — over a real HTTP server on 127.0.0.1, so the client's timeouts,
// status handling and framing are exercised by a socket rather than by a stub that returns a `Response`.
//
// The server can be told to be slow, to fail a route, to reject a checkpoint by name, to fail the first N jobs, to return
// bytes that are not a picture and to lack the ComfyUI-GGUF custom node. The last five are the shapes an adapter has to
// survive: a server that says no is not the same as one that is not there.
//
// No dependency: `node:http`, `node:crypto` for the WebSocket handshake's SHA-1 and `node:zlib` through the shared PNG
// encoder in `harness.ts`.

import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"

import { encodePng, solid } from "./harness.ts"

export interface FakeComfyOptions {
  // An HTTP status for one route, so the client's "not 200" path is tested without breaking the others.
  readonly objectInfoStatus?: number
  readonly uploadStatus?: number
  readonly promptStatus?: number
  readonly historyStatus?: number
  readonly viewStatus?: number
  // Every request waits this long before answering. A timeout test sets it above the client's timeout.
  readonly slowMs?: number
  // `/view` answers 200 with a body that is not a picture.
  readonly brokenImage?: boolean
  // The first N jobs end in `status_str: "error"` with an exception message.
  readonly failJobs?: number
  // `/history` answers `{}` for this many polls per job before it finishes.
  readonly pendingPolls?: number
  // A checkpoint name that `/prompt` refuses with node errors and HTTP 400.
  readonly blockedCheckpoint?: string
  // A job finishes only after `/ws` has sent its progress frames, so the watch test has a reason to open one.
  readonly deferUntilWs?: boolean
  // Do not answer the upgrade. The client falls back to history polling, as it would on a host without WebSocket.
  readonly noWebSocket?: boolean
  // A stock ComfyUI: no ComfyUI-GGUF custom node, so `/object_info` has no `UnetLoaderGGUF`. A `.gguf` diffusion model
  // that needs it must be refused rather than queued.
  readonly withoutGguf?: boolean
}

interface Job {
  readonly id: string
  readonly workflow: unknown
  readonly fail: boolean
  done: boolean
  polls: number
  ws: boolean
  doneAfterPolls?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The file a workflow's loader names, in either shape: a checkpoint loader's `ckpt_name` or a unet loader's `unet_name`.
// The fake refuses a blocked `checkpoint` by name, and a split graph names its diffusion model the same way.
function modelFileOf(workflow: unknown): string | undefined {
  if (!isRecord(workflow)) return undefined
  for (const node of Object.values(workflow)) {
    if (!isRecord(node)) continue
    const inputs = node["inputs"]
    if (!isRecord(inputs)) continue
    if (node["class_type"] === "CheckpointLoaderSimple" && typeof inputs["ckpt_name"] === "string") {
      return inputs["ckpt_name"]
    }
    if ((node["class_type"] === "UNETLoader" || node["class_type"] === "UnetLoaderGGUF") && typeof inputs["unet_name"] === "string") {
      return inputs["unet_name"]
    }
  }
  return undefined
}

// The latent the graph asked for. Both latent nodes are read: a checkpoint graph uses `EmptyLatentImage`, a split graph
// the SD3-shaped one, and `/view` answers the size the slot asked for either way.
function sizeOf(workflow: unknown): { width: number; height: number } {
  if (isRecord(workflow)) {
    for (const node of Object.values(workflow)) {
      if (!isRecord(node)) continue
      const kind = node["class_type"]
      if (kind !== "EmptyLatentImage" && kind !== "EmptySD3LatentImage" && kind !== "EmptyFlux2LatentImage") continue
      const inputs = node["inputs"]
      if (!isRecord(inputs)) continue
      const width = inputs["width"]
      const height = inputs["height"]
      if (typeof width === "number" && typeof height === "number") return { width, height }
    }
  }
  return { width: 64, height: 64 }
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export class FakeComfy {
  // Mutable on purpose: a test creates one server and turns one fault on for one case, which is clearer than six
  // constructor option sets that differ in a single field.
  objectInfoStatus?: number
  uploadStatus?: number
  promptStatus?: number
  historyStatus?: number
  viewStatus?: number
  slowMs = 0
  brokenImage = false
  failJobs = 0
  pendingPolls = 0
  blockedCheckpoint?: string
  deferUntilWs = false
  noWebSocket = false
  withoutGguf = false

  readonly requests: string[] = []
  readonly prompts: unknown[] = []
  // How many `/prompt` requests were being answered at the same moment, and the most that ever were. One render at a
  // time is a claim about the adapter's loop, and this is the number that can be read instead of believed (B5-T6).
  inFlightPrompts = 0
  peakPrompts = 0
  readonly uploaded: string[] = []
  readonly jobIds: string[] = []

  readonly #server = createServer((request, response) => {
    void this.#handle(request, response)
  })
  readonly #sockets = new Set<Socket>()
  readonly #jobs = new Map<string, Job>()

  constructor(options: FakeComfyOptions = {}) {
    Object.assign(this, options)
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket)
      socket.on("close", () => this.#sockets.delete(socket))
      socket.on("error", () => this.#sockets.delete(socket))
    })
    this.#server.on("upgrade", (request, socket) => this.#upgrade(request, socket as Socket))
  }

  get url(): string {
    const address = this.#server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve))
    return this
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    this.requests.push(`${request.method ?? "GET"} ${url.pathname}`)
    if (this.slowMs > 0) await sleep(this.slowMs)
    try {
      if (url.pathname === "/object_info") {
        if (this.objectInfoStatus !== undefined) return this.#status(response, this.objectInfoStatus)
        // The catalogue a split graph reads: the stock loaders, the latent the three families key, and the GGUF unet
        // loader only when this server is supposed to have the ComfyUI-GGUF custom node.
        const classes: Record<string, unknown> = {
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [["sdxl-base.safetensors"], {}] } },
            output: ["MODEL", "CLIP", "VAE"],
          },
          UNETLoader: {
            input: {
              required: {
                unet_name: [["z_image_turbo_int8_convrot.safetensors"], {}],
                weight_dtype: [["default", "fp8_e4m3fn", "fp8_e5m2"], {}],
              },
            },
            output: ["MODEL"],
          },
          CLIPLoader: {
            input: {
              required: {
                clip_name: [["qwen_3_4b_fp8_mixed.safetensors"], {}],
                type: [["stable_diffusion", "qwen_image", "flux2", "lumina2"], {}],
              },
            },
            output: ["CLIP"],
          },
          VAELoader: { input: { required: { vae_name: [["ae.safetensors"], {}] } }, output: ["VAE"] },
          EmptyLatentImage: { input: {}, output: ["LATENT"] },
          EmptySD3LatentImage: { input: {}, output: ["LATENT"] },
          EmptyFlux2LatentImage: { input: {}, output: ["LATENT"] },
          KSampler: { input: {}, output: ["LATENT"] },
          VAEDecode: { input: {}, output: ["IMAGE"] },
          SaveImage: { input: {}, output: [] },
        }
        if (!this.withoutGguf) {
          classes["UnetLoaderGGUF"] = { input: { required: { unet_name: [["qwen-image-2.1-Q4_K_M.gguf"], {}] } }, output: ["MODEL"] }
        }
        return this.#json(response, 200, classes)
      }

      if (url.pathname === "/upload/image") {
        if (this.uploadStatus !== undefined) return this.#status(response, this.uploadStatus)
        const text = (await bodyOf(request)).toString("utf8")
        const name = /filename="([^"]+)"/.exec(text)?.[1] ?? "upload.png"
        this.uploaded.push(name)
        return this.#json(response, 200, { name, subfolder: "", type: "input" })
      }

      if (url.pathname === "/prompt") {
        this.inFlightPrompts += 1
        this.peakPrompts = Math.max(this.peakPrompts, this.inFlightPrompts)
        try {
          if (this.promptStatus !== undefined) return this.#status(response, this.promptStatus)
          let parsed: unknown
          try {
            parsed = JSON.parse((await bodyOf(request)).toString("utf8"))
          } catch {
            return this.#json(response, 400, { error: { message: "not JSON" } })
          }
          const workflow = isRecord(parsed) ? parsed["prompt"] : undefined
          this.prompts.push(workflow)
          const checkpoint = modelFileOf(workflow)
          if (this.blockedCheckpoint !== undefined && checkpoint === this.blockedCheckpoint) {
            return this.#json(response, 400, {
              error: { message: `checkpoint ${checkpoint} is not allowed` },
              node_errors: { "4": { errors: [{ message: "blocked checkpoint" }] } },
            })
          }
          const id = `job-${this.jobIds.length + 1}`
          const job: Job = {
            id,
            workflow,
            fail: this.failJobs > this.jobIds.length,
            done: false,
            polls: 0,
            ws: false,
          }
          this.jobIds.push(id)
          this.#jobs.set(id, job)
          return this.#json(response, 200, { prompt_id: id, number: this.jobIds.length })
        } finally {
          this.inFlightPrompts -= 1
        }
      }

      if (url.pathname.startsWith("/history/")) {
        if (this.historyStatus !== undefined) return this.#status(response, this.historyStatus)
        const id = decodeURIComponent(url.pathname.slice("/history/".length))
        const job = this.#jobs.get(id)
        if (job === undefined) return this.#json(response, 200, {})
        job.polls += 1

        // A deferred job says nothing until the upgrade happened; after that the websocket path decides when it is done.
        if (this.deferUntilWs && !job.ws) return this.#json(response, 200, {})
        const readyByPolls = !this.deferUntilWs && job.polls > this.pendingPolls
        const readyByWs = job.doneAfterPolls !== undefined && job.polls >= job.doneAfterPolls
        if (!job.done && !readyByPolls && !readyByWs) return this.#json(response, 200, {})
        if (job.fail) return this.#json(response, 200, this.#failed(job))
        return this.#json(response, 200, this.#finished(job))
      }

      if (url.pathname === "/view") {
        if (this.viewStatus !== undefined) return this.#status(response, this.viewStatus)
        if (this.brokenImage) {
          response.writeHead(200, { "content-type": "text/html" })
          response.end("<html>this is not a picture</html>")
          return
        }
        const filename = url.searchParams.get("filename") ?? ""
        const job = this.#jobs.get(filename.replace(/\.png$/, ""))
        const size = sizeOf(job?.workflow)
        const png = encodePng(size.width, size.height, 6, solid([40, 120, 200, 255]))
        response.writeHead(200, { "content-type": "image/png", "content-length": png.length })
        response.end(png)
        return
      }

      this.#json(response, 404, { error: { message: "no such route" } })
    } catch {
      if (!response.writableEnded && !response.destroyed) {
        try {
          response.writeHead(500, { "content-type": "text/plain" })
          response.end("the fake failed")
        } catch {
          // The client went away mid-answer: there is no one left to tell.
        }
      }
    }
  }

  #finished(job: Job): Record<string, unknown> {
    return {
      [job.id]: {
        status: { status_str: "success", completed: true, messages: [] },
        outputs: {
          "9": { images: [{ filename: `${job.id}.png`, subfolder: "", type: "output" }] },
        },
      },
    }
  }

  #failed(job: Job): Record<string, unknown> {
    return {
      [job.id]: {
        status: {
          status_str: "error",
          completed: false,
          messages: [["execution_error", { exception_message: "out of memory" }]],
        },
        outputs: {},
      },
    }
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded || response.destroyed) return
    const body = JSON.stringify(value)
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
    response.end(body)
  }

  #status(response: ServerResponse, status: number): void {
    if (response.writableEnded || response.destroyed) return
    response.writeHead(status, { "content-type": "text/plain" })
    response.end(`HTTP ${status}`)
  }

  // The WebSocket handshake and three progress frames, then an `executing` message with a null node, which is how
  // ComfyUI says the job is over. Completion is still read from `/history`: the upgrade makes the job answer only after
  // a few polls, so the client has time to receive the frames before the watch returns.
  #upgrade(request: IncomingMessage, socket: Socket): void {
    this.#sockets.add(socket)
    socket.on("data", () => {})
    socket.on("error", () => this.#sockets.delete(socket))
    if (this.noWebSocket) {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n")
      return
    }
    const key = request.headers["sec-websocket-key"]
    if (typeof key !== "string") {
      socket.destroy()
      return
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const job = [...this.#jobs.values()].at(-1)
    if (job === undefined) return
    job.ws = true
    job.doneAfterPolls = job.polls + 3
    for (let value = 1; value <= 3; value += 1) {
      this.#send(socket, { type: "progress", data: { prompt_id: job.id, node: "3", value, max: 3 } })
    }
    this.#send(socket, { type: "executing", data: { prompt_id: job.id, node: null } })
  }

  #send(socket: Socket, value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), "utf8")
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length])
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    socket.write(Buffer.concat([header, payload]))
  }
}
