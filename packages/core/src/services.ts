// Where the local services are and how to talk to them: the decider (GLiNER behind the decision wire format) and the
// memory's embedding service. On a desktop they sit on their fixed loopback ports and need no token. In the container
// (docs/roadmap/container-plan.md) the entrypoint starts both behind a supervisor on random loopback ports and hands
// their base URLs and one bearer token in through the environment, because under Apptainer the loopback is shared with
// every user of the machine and a fixed port would collide with a decider the host already runs.
//
// The supervisor answers 503 with `x-omacode-starting: 1` while a service it stopped after an idle time starts again;
// `startingWaitMs` is how long a caller may wait for that instead of treating the service as gone.

export type ServiceName = "decider" | "embedding"

export const SERVICE_DEFAULTS: Readonly<Record<ServiceName, string>> = {
  decider: "http://127.0.0.1:8781",
  embedding: "http://127.0.0.1:8093",
}

const URL_VARS: Readonly<Record<ServiceName, string>> = {
  decider: "OMACODE_DECIDER_URL",
  embedding: "OMACODE_EMBEDDING_URL",
}

export const STARTING_HEADER = "x-omacode-starting"

// The base URL of a service, without a trailing slash: the container's when it set one, else the desktop default.
export function serviceUrl(name: ServiceName, env: NodeJS.ProcessEnv = process.env): string {
  return (env[URL_VARS[name]]?.trim() || SERVICE_DEFAULTS[name]).replace(/\/+$/, "")
}

// The token the container's services expect, or undefined on a desktop.
export function serviceToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OMACODE_SERVICE_TOKEN?.trim() || undefined
}

// The header that carries the token, or none.
export function serviceHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = serviceToken(env)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// The embedding model the container's service runs; undefined means the caller's own default.
export function embeddingModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OMACODE_EMBEDDING_MODEL?.trim() || undefined
}

// How long a caller waits for a service the supervisor is starting again. Zero outside the container: there nothing
// answers "starting", and a desktop decider that is down stays a fast fallback.
export function startingWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OMACODE_STARTING_WAIT_MS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return env.OMACODE_SERVICE_TOKEN ? 90_000 : 0
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
