// A6: the decider and the embedding service as one user service on a host. A fake uv and systemctl stand in, in a
// temporary home; the supervisor's own behaviour is test/supervisor.test.ts's.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"

import { tempDir } from "./harness.ts"

import { embeddingModel, serviceHeaders, serviceToken, serviceUrl, startingWaitMs } from "../packages/core/src/services.ts"
import { findLlamaServer, ggufFor, install, launchdPlist, remove, status, systemdUnit, unitPath, type ServicesConfig } from "../packages/micromanager/src/services.ts"
import { hostServices } from "../packages/micromanager/src/services-main.ts"
import type { Exec } from "../packages/micromanager/src/worktree/git.ts"

const ROOT = tempDir("mm-services-")
after(() => rmSync(ROOT, { recursive: true, force: true }))

function fakeRun(fail: Record<string, boolean> = {}) {
  const calls: string[] = []
  const run: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(" ")
    calls.push(line)
    return { code: Object.entries(fail).some(([k, v]) => v && line.startsWith(k)) ? 1 : 0, stdout: "", stderr: "", timedOut: false }
  }
  return { run, calls }
}

let n = 0
function machine(withOld = false) {
  const home = join(ROOT, `home-${++n}`)
  const source = join(home, "checkout", "decider")
  for (const dir of [".venv/bin", "train", "tests", "decider", "models/guard-2026-11-21"]) mkdirSync(join(source, dir), { recursive: true })
  writeFileSync(join(source, "uv.lock"), "lock")
  writeFileSync(join(source, "decider", "server.py"), "")
  writeFileSync(join(source, "models", "guard-2026-11-21", "model.safetensors"), "w")
  writeFileSync(join(source, "train", "train.py"), "")
  const units = join(home, ".config", "systemd", "user")
  mkdirSync(units, { recursive: true })
  if (withOld) for (const u of ["decider", "micromanager-embedding"]) writeFileSync(join(units, `${u}.service`), "[Service]\n")
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "" }
  return { home, source, env, units, services: join(home, ".local", "share", "omacode", "services") }
}

test("install copies the decider without its environments, syncs it, and starts one user unit", async () => {
  const m = machine()
  const { run, calls } = fakeRun()
  const r = await install(run, { env: m.env, home: m.services, source: m.source, platform: "linux", node: "/usr/bin/node" })
  assert.equal(r.ok, true, r.text)
  const copy = join(m.services, "decider")
  assert.ok(existsSync(join(copy, "decider", "server.py")))
  for (const gone of [".venv", "train", "tests"]) assert.equal(existsSync(join(copy, gone)), false, `${gone} is not copied`)
  assert.ok(calls.includes("uv sync --frozen --no-dev"))
  const config = JSON.parse(readFileSync(join(m.services, "config.json"), "utf8")) as ServicesConfig
  assert.equal(config.decider.model, join(copy, "models", "guard-2026-11-21"), "the tuned checkpoint the plugin ships")
  assert.equal(config.decider.bin, join(copy, ".venv", "bin", "decider"))
  assert.equal(config.embedding.model, "qwen3-embedding-0.6b", "the small model when none is on the machine")
  assert.deepEqual(config.modes, { decider: "auto", embedding: "off" }, "no llama.cpp server here: embedding off, keywords only")
  const unit = readFileSync(unitPath("linux", m.env), "utf8")
  assert.match(unit, /^ExecStart=\/usr\/bin\/node .*services-main\.ts$/m)
  assert.match(unit, new RegExp(`OMACODE_SERVICES_HOME=${m.services.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`))
  assert.ok(calls.includes("systemctl --user enable --now omacode-services.service"))
})

test("install refuses to run beside the old units, and --replace stops and disables them", async () => {
  const m = machine(true)
  const first = await install(fakeRun().run, { env: m.env, home: m.services, source: m.source, platform: "linux" })
  assert.equal(first.ok, false)
  assert.match(first.text, /decider\.service and micromanager-embedding\.service .* --replace/)
  const { run, calls } = fakeRun()
  const r = await install(run, { env: m.env, home: m.services, source: m.source, platform: "linux", replace: true })
  assert.equal(r.ok, true, r.text)
  assert.ok(calls.includes("systemctl --user disable --now decider.service"))
  assert.ok(calls.includes("systemctl --user disable --now micromanager-embedding.service"))
  assert.ok(existsSync(join(m.units, "decider.service")), "the old unit file stays")
})

test("an embedding file already on the machine is used, and its size chosen", async () => {
  const m = machine()
  const old = join(m.home, "Models", "gguf", "qwen3-embedding-4b")
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, "Qwen3-Embedding-4B-Q8_0.gguf"), "gguf")
  const bin = join(m.home, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "llama-server"), "#!/bin/sh\n", { mode: 0o755 })
  const env = { ...m.env, PATH: bin }
  assert.deepEqual(findLlamaServer(env), [join(bin, "llama-server")])
  assert.equal(ggufFor("4b", m.services, env).present, true)
  const r = await install(fakeRun().run, { env, home: m.services, source: m.source, platform: "linux" })
  assert.equal(r.ok, true, r.text)
  const config = JSON.parse(readFileSync(join(m.services, "config.json"), "utf8")) as ServicesConfig
  assert.equal(config.embedding.model, "qwen3-embedding-4b")
  assert.equal(config.embedding.gguf, join(old, "Qwen3-Embedding-4B-Q8_0.gguf"))
  assert.equal(config.modes?.embedding, "auto")
})

test("without uv nothing is written", async () => {
  const m = machine()
  const r = await install(fakeRun({ "uv --version": true }).run, { env: m.env, home: m.services, source: m.source, platform: "linux" })
  assert.equal(r.ok, false)
  assert.match(r.text, /uv is not installed/)
  assert.equal(existsSync(join(m.services, "config.json")), false)
})

test("the supervisor's services: the decider with its token, the embedding fetched only when its file is missing", () => {
  const config: ServicesConfig = {
    decider: { bin: "/d/.venv/bin/decider", model: "/d/models/m" },
    embedding: { server: ["/bin/llama-vulkan", "serve"], gguf: join(ROOT, "absent.gguf"), url: "https://x/y.gguf", model: "qwen3-embedding-0.6b" },
  }
  const [decider, embedding] = hostServices(config, "tok")
  const d = decider!.command(9001)
  assert.deepEqual([d.cmd, d.args], ["/d/.venv/bin/decider", ["--host", "127.0.0.1", "--port", "9001", "--model", "/d/models/m"]])
  assert.equal(d.env?.DECIDER_TOKEN, "tok")
  const e = embedding!.command(9002)
  assert.equal(e.cmd, "/bin/llama-vulkan")
  assert.deepEqual(e.args.slice(0, 2), ["serve", "--embedding"])
  assert.ok(e.args.includes("--api-key") && e.args.includes("tok"))
  assert.equal(typeof embedding!.prepare, "function", "a missing file is fetched before the first start")
  assert.equal(hostServices({ ...config, embedding: { ...config.embedding, server: [] } }, "tok").length, 1, "no server, no embedding service")
})

test("the plugin finds a host supervisor through its run directory, after the environment and before the fixed ports", () => {
  const dir = join(ROOT, "run")
  mkdirSync(join(dir, "omacode"), { recursive: true })
  const env = { XDG_RUNTIME_DIR: dir }
  assert.equal(serviceUrl("decider", env), "http://127.0.0.1:8781", "nothing there: the fixed port")
  assert.equal(serviceToken(env), undefined)
  assert.equal(startingWaitMs(env), 0)
  writeFileSync(join(dir, "omacode", "services.json"), JSON.stringify({ decider: "http://127.0.0.1:8781", embedding: "http://127.0.0.1:8093", embeddingModel: "qwen3-embedding-4b" }))
  writeFileSync(join(dir, "omacode", "token"), "secret-token\n")
  assert.equal(serviceToken(env), "secret-token")
  assert.deepEqual(serviceHeaders(env), { Authorization: "Bearer secret-token" })
  assert.equal(embeddingModel(env), "qwen3-embedding-4b")
  assert.equal(startingWaitMs(env), 90_000, "a supervisor answers starting: wait for it")
  assert.equal(serviceUrl("decider", { ...env, OMACODE_DECIDER_URL: "http://10.0.0.2:1/" }), "http://10.0.0.2:1", "the environment wins")
  assert.equal(serviceToken({ ...env, OMACODE_DECIDER_URL: "http://10.0.0.2:1" }), undefined, "a decider named by URL gets no token from here")
})

test("the unit files run the supervisor with the given node, and remove takes the unit away", async () => {
  assert.match(systemdUnit("/n", "/e.ts", "/h"), /ExecStart=\/n \/e\.ts/)
  assert.match(launchdPlist("/n", "/e.ts", "/h", "/r"), /<string>\/n<\/string><string>\/e\.ts<\/string>/)
  const m = machine()
  await install(fakeRun().run, { env: m.env, home: m.services, source: m.source, platform: "linux" })
  const { run, calls } = fakeRun()
  const text = await remove(run, { env: m.env, home: m.services, platform: "linux" })
  assert.match(text, /stay in/)
  assert.equal(existsSync(unitPath("linux", m.env)), false)
  assert.ok(existsSync(join(m.services, "config.json")))
  assert.ok(calls.includes("systemctl --user disable --now omacode-services.service"))
  await remove(fakeRun().run, { env: m.env, home: m.services, platform: "linux", purge: true })
  assert.equal(existsSync(m.services), false)
  assert.match(status({ OMACODE_RUN_DIR: join(ROOT, "nothing") }), /not running/)
})
