// The host's supervisor process (A6): what the `omacode-services` unit runs. It reads the config `omacode services
// install` wrote, keeps a token in the run directory (only the user can read it; the plugin sends it), and starts the
// supervisor with the decider and the embedding service on their usual ports.

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { runDir } from "@omacode/core/services"
import { fetchOnce, Supervisor, type Device, type ServiceSpec } from "@omacode/core/supervisor"

import { configPath, PORTS, servicesHome, type ServicesConfig } from "./services.ts"

export const CPU: Device = { id: "cpu", name: "CPU" }

// llama.cpp's --list-devices: "  Vulkan0: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 6990 MiB free)".
export function parseDevices(text: string): Device[] {
  const out: Device[] = [CPU]
  for (const line of text.split("\n")) {
    const m = /^\s+([A-Za-z]+\d*):\s+(.+?)\s*(?:\((\d+) MiB,.*\))?\s*$/.exec(line)
    if (m) out.push({ id: m[1]!, name: m[3] ? `${m[2]} · ${Math.round(Number(m[3]) / 1024)} GB` : m[2]! })
  }
  return out
}

function listDevices(server: string, prefix: readonly string[]): Promise<Device[]> {
  return new Promise((done) => {
    execFile(server, [...prefix, "--list-devices"], { timeout: 20_000 }, (_err, stdout, stderr) => done(parseDevices(`${stdout}\n${stderr}`)))
  })
}

// "cpu": no GPU at all (-dev none, no layers offloaded); any other id: every layer on that one device.
export function deviceArgs(device: string | undefined): string[] {
  return !device || device === CPU.id ? ["-dev", "none", "-ngl", "0"] : ["-dev", device, "-ngl", "999"]
}

export function hostServices(config: ServicesConfig, token: string): ServiceSpec[] {
  const specs: ServiceSpec[] = [
    {
      name: "decider",
      // CPU-only PyTorch (decider/pyproject.toml): the GPUs stay free for llama.cpp, and a decision takes ~40 ms anyway.
      // A GPU would need a second torch build beside it (CUDA, or ROCm's preview for the iGPU); not taken (2026-11-23).
      devices: async () => [{ ...CPU, note: "CPU only: its PyTorch build has no GPU support; a decision takes about 40 ms" }],
      defaultDevice: CPU.id,
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
      devices: () => listDevices(server, prefix),
      defaultDevice: config.embedding.device ?? CPU.id,
      command: (port, device) => ({
        cmd: server,
        args: [
          ...prefix, "--embedding", "--pooling", "last", "-m", config.embedding.gguf, "--alias", config.embedding.model,
          ...deviceArgs(device), "-c", "8192", "-b", "2048", "-ub", "2048", "--host", "127.0.0.1", "--port", String(port), "--api-key", token,
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
    // Beside config.json, on disk: the TUI's picks (mode, device, idle time) outlive a reboot.
    controlPath: join(home, "control.json"),
  })
  const shutdown = () => void sup.close().then(() => process.exit(0))
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
