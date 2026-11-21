// Where the local services are and how to talk to them: the decider (GLiNER behind the decision wire format) and the
// memory's embedding service. On a desktop they sit on their fixed loopback ports and need no token. In the container
// (docs/roadmap/container-plan.md) the entrypoint starts both behind a supervisor on random loopback ports and hands
// their base URLs and one bearer token in through the environment, because under Apptainer the loopback is shared with
// every user of the machine and a fixed port would collide with a decider the host already runs.
//
// On a host the service installer (A6, `omacode services install`) runs the same supervisor as a user service; it
// writes the services' URLs to <run dir>/services.json and the token to <run dir>/token, in $XDG_RUNTIME_DIR/omacode,
// which only the user can read. The order is the environment, then that directory, then the fixed ports.
//
// The supervisor answers 503 with `x-omacode-starting: 1` while a service it stopped after an idle time starts again;
// `startingWaitMs` is how long a caller may wait for that instead of treating the service as gone.

import { readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type ServiceName = "decider" | "embedding"

// Where a supervisor on this machine keeps its files: the container's run directory, else the user's runtime directory.
export function runDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMACODE_RUN_DIR?.trim()) return env.OMACODE_RUN_DIR.trim()
  return join(env.XDG_RUNTIME_DIR?.trim() || join(tmpdir(), `omacode-${process.getuid?.() ?? "user"}`), "omacode")
}

// What the supervisor wrote, read again only when the file changed: every decision and every embedding asks for a URL.
let cached: { path: string; mtime: number; urls: Partial<Record<ServiceName, string>>; token?: string; embeddingModel?: string } | undefined
function discovered(env: NodeJS.ProcessEnv): { urls: Partial<Record<ServiceName, string>>; token?: string; embeddingModel?: string } {
  const dir = runDir(env)
  const path = join(dir, "services.json")
  try {
    const mtime = statSync(path).mtimeMs
    if (cached && cached.path === path && cached.mtime === mtime) return cached
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const urls: Partial<Record<ServiceName, string>> = {}
    for (const name of ["decider", "embedding"] as const) if (typeof raw[name] === "string") urls[name] = raw[name] as string
    let token: string | undefined
    try {
      token = readFileSync(join(dir, "token"), "utf8").trim() || undefined
    } catch {
      token = undefined
    }
    const model = typeof raw.embeddingModel === "string" ? raw.embeddingModel : undefined
    cached = { path, mtime, urls, ...(token ? { token } : {}), ...(model ? { embeddingModel: model } : {}) }
    return cached
  } catch {
    return { urls: {} }
  }
}

export const SERVICE_DEFAULTS: Readonly<Record<ServiceName, string>> = {
  decider: "http://127.0.0.1:8781",
  embedding: "http://127.0.0.1:8093",
}

const URL_VARS: Readonly<Record<ServiceName, string>> = {
  decider: "OMACODE_DECIDER_URL",
  embedding: "OMACODE_EMBEDDING_URL",
}

export const STARTING_HEADER = "x-omacode-starting"

// The base URL of a service, without a trailing slash: the environment's, else the supervisor's on this machine, else
// the fixed port.
export function serviceUrl(name: ServiceName, env: NodeJS.ProcessEnv = process.env): string {
  return (env[URL_VARS[name]]?.trim() || discovered(env).urls[name] || SERVICE_DEFAULTS[name]).replace(/\/+$/, "")
}

// The token the services expect, or undefined for services on their fixed ports.
export function serviceToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OMACODE_SERVICE_TOKEN?.trim()) return env.OMACODE_SERVICE_TOKEN.trim()
  if (env[URL_VARS.decider]?.trim() || env[URL_VARS.embedding]?.trim()) return undefined
  return discovered(env).token
}

// The header that carries the token, or none.
export function serviceHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = serviceToken(env)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// The embedding model the container's service runs; undefined means the caller's own default.
export function embeddingModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OMACODE_EMBEDDING_MODEL?.trim() || discovered(env).embeddingModel || undefined
}

// How long a caller waits for a service the supervisor is starting again. Zero without a supervisor: then nothing
// answers "starting", and a decider on its fixed port that is down stays a fast fallback.
export function startingWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMACODE_STARTING_WAIT_MS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return serviceToken(env) ? 90_000 : 0
}

// Whether a response says "the service is starting, ask again" rather than "the service failed".
export function isStarting(response: Response): boolean {
  return response.status === 503 && response.headers.get(STARTING_HEADER) === "1"
}

// The pause before asking again: the server's Retry-After (seconds), within 0.5 to 5 seconds.
export function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"))
  return Math.min(5000, Math.max(500, Number.isFinite(seconds) ? seconds * 1000 : 1000))
}
