// The image's two services and the supervisor's entrypoint there (container plan P1-T2). The supervisor itself lives in
// @omacode/core/supervisor, where the host's service installer (A6, packages/micromanager/src/services.ts) uses it too.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { fetchOnce, SERVICE_MODES as MODES, Supervisor, type Mode, type ServiceSpec } from "../packages/core/src/supervisor.ts"

export * from "../packages/core/src/supervisor.ts"

const EMBEDDING_SIZES: Readonly<Record<string, string>> = { "0.6b": "0.6B", "4b": "4B", "8b": "8B" }

export function imageServices(env: NodeJS.ProcessEnv = process.env): ServiceSpec[] {
  const token = env.OMACODE_SERVICE_TOKEN
  const models = env.OMACODE_MODELS || join(env.HOME || homedir(), ".cache", "omacode", "models")
  const size = EMBEDDING_SIZES[(env.OMACODE_EMBEDDING_SIZE || "0.6b").toLowerCase()] ?? "0.6B"
  // The image carries the 0.6B weights (OMACODE_IMAGE_MODELS, P1-T9); a shared read-only directory or the container
  // home's cache holds any other size, downloaded once.
  const file = join(`qwen3-embedding-${size.toLowerCase()}`, `Qwen3-Embedding-${size}-Q8_0.gguf`)
  const baked = [env.OMACODE_IMAGE_MODELS, env.OMACODE_SHARED_MODELS].filter(Boolean).map((dir) => join(dir!, file)).find((p) => existsSync(p))
  const gguf = baked ?? join(models, file)
  return [
    {
      name: "decider",
      command: (port) => ({
        cmd: env.OMACODE_DECIDER_BIN || "/opt/omacode/decider/.venv/bin/decider",
        args: ["--host", "127.0.0.1", "--port", String(port), "--model", env.OMACODE_DECIDER_MODEL || "fastino/GLiNER2.5-multi-Decide"],
        env: { CUDA_VISIBLE_DEVICES: "", ...(token ? { DECIDER_TOKEN: token } : {}) },
      }),
    },
    {
      name: "embedding",
      prepare: (progress) =>
        fetchOnce(`https://huggingface.co/Qwen/Qwen3-Embedding-${size}-GGUF/resolve/main/Qwen3-Embedding-${size}-Q8_0.gguf`, gguf, progress),
      command: (port) => ({
        cmd: env.OMACODE_LLAMA_SERVER || "llama-server",
        args: [
          "--embedding", "--pooling", "last", "-m", gguf, "--alias", `qwen3-embedding-${size.toLowerCase()}`,
          "-ngl", "0", "-c", "8192", "-b", "2048", "-ub", "2048", "--host", "127.0.0.1", "--port", String(port),
          ...(token ? ["--api-key", token] : []),
        ],
      }),
    },
  ]
}

const modeOf = (value: string | undefined): Mode | undefined => (MODES.includes(value as Mode) ? (value as Mode) : undefined)

// `node supervisor.ts`: the entrypoint runs it in the background and waits for <run>/services.json.
if (import.meta.main) {
  const runDir = process.env.OMACODE_RUN_DIR
  if (!runDir) {
    console.error("supervisor: OMACODE_RUN_DIR is not set")
    process.exit(2)
  }
  const defaults: Record<string, Mode> = {}
  for (const n of ["decider", "embedding"]) {
    const m = modeOf(process.env[`OMACODE_${n.toUpperCase()}_MODE`])
    if (m) defaults[n] = m
  }
  const sup = await Supervisor.start({ runDir, token: process.env.OMACODE_SERVICE_TOKEN, services: imageServices(), defaults })
  const shutdown = () => void sup.close().then(() => process.exit(0))
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
