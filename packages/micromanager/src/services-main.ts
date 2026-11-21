// The host's supervisor process (A6): what the `omacode-services` unit runs. It reads the config `omacode services
// install` wrote, keeps a token in the run directory (only the user can read it; the plugin sends it), and starts the
// supervisor with the decider and the embedding service on their usual ports.

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { runDir } from "@omacode/core/services"
import { fetchOnce, Supervisor, type ServiceSpec } from "@omacode/core/supervisor"

import { configPath, PORTS, servicesHome, type ServicesConfig } from "./services.ts"

export function hostServices(config: ServicesConfig, token: string): ServiceSpec[] {
  const specs: ServiceSpec[] = [
    {
      name: "decider",
      command: (port) => ({
        cmd: config.decider.bin,
        args: ["--host", "127.0.0.1", "--port", String(port), "--model", config.decider.model],
        env: { CUDA_VISIBLE_DEVICES: "", DECIDER_TOKEN: token },
      }),
    },
  ]
  const [server, ...prefix] = config.embedding.server
  if (server) {
    specs.push({
      name: "embedding",
      ...(existsSync(config.embedding.gguf) ? {} : { prepare: (progress: (text: string) => void) => fetchOnce(config.embedding.url, config.embedding.gguf, progress) }),
      command: (port) => ({
        cmd: server,
        args: [
          ...prefix, "--embedding", "--pooling", "last", "-m", config.embedding.gguf, "--alias", config.embedding.model,
          "-dev", "none", "-ngl", "0", "-c", "8192", "-b", "2048", "-ub", "2048", "--host", "127.0.0.1", "--port", String(port), "--api-key", token,
        ],
      }),
    })
  }
  return specs
}

function token(dir: string): string {
  const file = join(dir, "token")
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim()
    if (t) return t
  }
  const t = randomBytes(24).toString("base64url")
  writeFileSync(file, t + "\n", { mode: 0o600 })
  return t
}

if (import.meta.main) {
  const home = process.env.OMACODE_SERVICES_HOME || servicesHome()
  const config = JSON.parse(readFileSync(configPath(home), "utf8")) as ServicesConfig
  const dir = runDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const t = token(dir)
  const sup = await Supervisor.start({
    runDir: dir,
    token: t,
    services: hostServices(config, t),
    defaults: config.modes ?? {},
    ...(config.idleMinutes ? { idleMs: config.idleMinutes * 60_000 } : {}),
    // OMACODE_DECIDER_PORT / OMACODE_EMBEDDING_PORT: other ports, for a test beside services already running.
    ports: { decider: Number(process.env.OMACODE_DECIDER_PORT) || PORTS.decider, embedding: Number(process.env.OMACODE_EMBEDDING_PORT) || PORTS.embedding },
    facts: { embeddingModel: config.embedding.model },
  })
  const shutdown = () => void sup.close().then(() => process.exit(0))
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
