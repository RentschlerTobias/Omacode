// The HyperFrames runtime both adapters share (B2-T1): the tool row and licence, the precondition that answers whether
// the engine is here, the environment name and the GPU switch a run carries, one `hyperframesRun` every video call goes
// through, and the readers for the three envelopes the engine prints — `lint`, `check` and `snapshot`.
//
// The deck adapter grew these first (B3-T0/T3/T4) and they were never about a deck: a version probe is a version probe,
// and an envelope is the engine's shape, not the artifact's. Moving them here keeps the video adapter from writing a
// second reader that would drift from the one the deck tests already pin. The deck keeps its own names by re-exporting
// from `deck.ts`/`deck-run.ts`, so nothing that imported a deck had to change.
//
// Nothing here starts a program itself. Every function asks the host runner (B1-T5), which owns the allowlist, the
// environment, the working directory and the network; the answers are values, because a refusal, a crash and an
// unparseable envelope are all things a report has to be able to say.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs"
import { connect, createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { TELEMETRY_OFF } from "@omacode/core/telemetry"

import type { HostRunInput, HostRunner, HostRunResult } from "../adapter.ts"
import type { ToolProvenance } from "../provenance.ts"

// How the engine is installed so that the runner can find it. The prefix matters: a global npm install under this
// machine's node prefix writes its bin into `~/.local/bin`, which is already on the PATH the runner searches, while a
// project-local install (node_modules) is a path the runner never looks in. The plugin cannot widen the runner's search
// path for one adapter — that would be the adapter changing the rule that constrains it — so the message names the
// install that fits the rule instead.
export const HYPERFRAMES_INSTALL = "npm i -g --prefix ~/.local hyperframes"

// The tool row a produced artifact carries (B1-T3). HyperFrames is Apache-2.0, which places no restriction on where the
// result may be used, so the territory is "global" and not a guess. D18 records it anyway: an artifact that leaves this
// machine must say which engine made it and under which terms, and "there is no restriction" is itself a term a reader
// should not have to infer from a missing field.
export function hyperframesTool(version: string): ToolProvenance {
  return { name: "hyperframes", version, license: "Apache-2.0", territory: "global" }
}

// The answer the precondition produces. `version` is present exactly when `ok` is true, so a caller that has an ok
// check also has the version to hand `hyperframesTool`; `detail` is the diagnosis and never a second verdict.
export interface HyperframesCheck {
  readonly ok: boolean
  readonly version?: string
  readonly reason?: string
  readonly detail?: string
}

const VERSION_ARGS = ["--version"] as const
const DOCTOR_ARGS = ["doctor"] as const

// A semantic version, with the leading "v" some CLIs print allowed but not required: the command answers `0.9.54` here
// and a banner would say `hyperframes v0.9.54`, and both are the same fact for provenance. The first match is taken,
// because a version is what the output starts with; anything after it is the program describing itself.
const SEMVER = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/

// How many lines of `doctor` a failure carries. It is a table of environment facts; the first few are where the version,
// the binary and the runtime are, and the rest (optional transcribers, a Docker daemon a deck does not use) would turn a
// diagnosis into a wall of text in a message that is read once.
const DOCTOR_LINES = 6

// The end of an output, which is where a failure is. A whole browser log in a check's answer would bury the sentence
// above it, so the tail is kept and the front is dropped.
const TAIL_CHARS = 400

export const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

export const tailOf = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length > TAIL_CHARS ? `…${trimmed.slice(-TAIL_CHARS)}` : trimmed
}

const nonEmptyLines = (text: string, count: number): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, count)

// What the failing run itself said, in the reader's words. A refusal is the runner saying the program never started, and
// its sentence already names the rule that stopped it (the allowlist, the search path, the missing wrapper); repeating it
// is more useful than replacing it with "missing", which would send the reader looking for the wrong problem.
function whatHappened(result: HostRunResult): string {
  if (result.refused) return result.refused
  if (result.cancelled) return "the run was cancelled"
  if (result.timedOut) return "the run timed out"
  const said = firstLine(result.stderr)
  return said ? `hyperframes --version exited ${result.code} (${said})` : `hyperframes --version exited ${result.code}`
}

// The sentence a user reads when the engine is not usable. It carries the install command because that is the way out:
// a message that only named the failure would leave the reader to discover the prefix rule above on their own.
const unusable = (happened: string): string =>
  `HyperFrames is missing or not runnable: ${happened}. Install it with: ${HYPERFRAMES_INSTALL}`

// Whether HyperFrames can make an artifact on this machine, and which version would make it. The version is the gate: a
// program that runs and reports a version is usable, and everything else is a failure with a reason.
//
// `doctor` is the diagnosis and not the gate because it answers a different question. It reports optional extras — a
// transcriber, a local voice, a music model, a Docker daemon — that an artifact does not need, and a maker that refused
// to run until those were installed would be stricter than the product. So a failure runs `doctor` once and keeps its
// first lines as `detail`; a `doctor` that also fails leaves the detail off, because the two runs failed at the same
// door and saying so twice is not more information.
//
// This is a read: no file, no directory, no environment is written anywhere. A check that left something behind would
// make the next run look different for a reason that was not the machine's.
//
// `what` names the artifact in the one sentence that mentions it, so a deck's diagnosis still reads "a deck" and a
// video's reads "a video" without two copies of this probe.
export async function checkHyperframes(run: HostRunner, what = "a deck"): Promise<HyperframesCheck> {
  const input: HostRunInput = { exe: "hyperframes", args: [...VERSION_ARGS], env: { ...HYPERFRAMES_ENV } }
  const probe = await run.run(input)

  // The version may arrive on either stream: a CLI that banners to stdout and one that prints a version to stderr are
  // both telling the same fact, and a check that only read stdout would refuse a working program.
  const found = probe.passed ? SEMVER.exec(`${probe.stdout}\n${probe.stderr}`) : null
  if (found) return { ok: true, version: found[1]! }

  const detail: string[] = []
  let reason: string
  if (probe.passed) {
    // The program started, so it is installed; what it printed is not a version. That is a different failure from a
    // missing binary, and the message says what was printed rather than sending the reader to install it again.
    reason =
      `HyperFrames is installed but hyperframes --version printed no version, so ${what} could not say which engine made it`
    const printed = tailOf(`${probe.stdout}\n${probe.stderr}`)
    if (printed) detail.push(printed)
  } else {
    reason = unusable(whatHappened(probe))
  }

  const doctor = await run.run({ exe: "hyperframes", args: [...DOCTOR_ARGS], env: { ...HYPERFRAMES_ENV } })
  if (doctor.passed) detail.push(...nonEmptyLines(doctor.stdout || doctor.stderr, DOCTOR_LINES))

  return { ok: false, reason, ...(detail.length > 0 ? { detail: detail.join("\n") } : {}) }
}

// The runtime script the installed engine ships (`dist/hyperframe.runtime.iife.js`), found through the same
// `hyperframes` on PATH the runner starts, so the page and the presenter's player come from one release. A deck carries
// a copy of it: `hyperframes present` serves the project as written, and its player only injects a runtime (from a CDN)
// when a scene lives in its own file. Without one in the page nothing hides the scenes that are not playing and no scene
// list reaches the slideshow, so every slide is drawn on top of the others (2026-11-24).
export interface HyperframesRuntime {
  readonly file: string
  readonly version?: string
}

export const RUNTIME_FILE = "hyperframe.runtime.iife.js"

// The first executable `hyperframes` on PATH, the one a run of the host runner would start.
export function hyperframesBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env["PATH"] ?? "").split(":").filter(Boolean)) {
    const bin = join(dir, "hyperframes")
    try {
      accessSync(bin, constants.X_OK)
      return bin
    } catch {
      // not here
    }
  }
  return undefined
}

export function hyperframesRuntime(env: NodeJS.ProcessEnv = process.env): HyperframesRuntime | undefined {
  const bin = hyperframesBin(env)
  if (bin !== undefined) {
    let real: string
    try {
      real = realpathSync(bin)
    } catch {
      return undefined
    }
    // bin/hyperframes.mjs today; a dist/cli.js entry would be one level less deep, so walk up a few levels.
    for (let root = dirname(real), depth = 0; depth < 3; root = dirname(root), depth++) {
      const file = join(root, "dist", RUNTIME_FILE)
      if (!existsSync(file)) continue
      let version: string | undefined
      try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }
        if (typeof pkg.version === "string") version = pkg.version
      } catch {
        // a runtime without a readable package.json still runs; the version is only reported
      }
      return { file, ...(version ? { version } : {}) }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// One run, the environment, and the GPU switch.

// Chrome is found under `$HOME/.cache/hyperframes/chrome` (or `HYPERFRAMES_CACHE_DIR`, which the runner does not hand
// on: it is not on the sandbox's environment allowlist and a run cannot add to it). Under the runner HOME is
// `<job>/.home`, so on a machine that already has the managed headless shell, the job's cache is a link to the real one.
// A link is a directory entry inside the job and the cache behind it is only read; without it the CLI falls back to a
// system Chrome, which is slower and may not exist. A link that cannot be made is not a refusal: the run says what the
// CLI found, and that sentence is better than one this function invented.
export function ensureBrowserCache(jobDir: string): void {
  const real = process.env["HYPERFRAMES_CACHE_DIR"]?.trim() || join(homedir(), ".cache", "hyperframes")
  const cache = join(real, "chrome")
  const home = join(resolve(jobDir), ".home", ".cache", "hyperframes")
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    symlinkSync(cache, join(home, "chrome"), "dir")
  } catch {
    // Already linked (EEXIST), no cache on this machine, or a host that will not make the link. The CLI resolves Chrome
    // on its own either way; this is the fast path, not a rule.
  }
}

// The names the adapters declare and the values their runs hand them. A name is here because a run needs it; the value is
// here because this package, not the host environment, knows what it should be. Chrome inside bubblewrap cannot build a
// sandbox of its own and dies with `FATAL: No usable sandbox!`; HyperFrames normally notices a container by
// `/.dockerenv` or `/run/.containerenv`, and bwrap leaves neither marker, so the engine is told explicitly.
// The telemetry opt-outs ride along on every run (core/telemetry.ts): HyperFrames reports to PostHog otherwise.
export const HYPERFRAMES_ENV_NAMES = ["HYPERFRAMES_CHROME_SANDBOX", "HYPERFRAMES_NO_TELEMETRY", "DO_NOT_TRACK", "DISABLE_TELEMETRY"] as const
export const HYPERFRAMES_ENV = { HYPERFRAMES_CHROME_SANDBOX: "0", ...TELEMETRY_OFF } as const

// The flag that decides which GPU path the browser a run starts will take. The help says it plainly: "pass
// --no-browser-gpu for deterministic SwiftShader". Determinism is the first reason: a check, a snapshot and a render
// want the same pixels on every machine, so a slide's contrast, a frame's content and a film's encoded frames are facts
// about the artifact and not about the graphics driver that drew them.
//
// The second reason is this host. The auto-detected path launches `chrome-headless-shell` with
// `--use-gl=angle --use-angle=gl-egl --disable-software-rasterizer`, and that child aborts with SIGTRAP on every run: the
// user's coredump store filled with dumps that all point at our own temp job directories, and each one fires their crash
// notifier. The same command with this flag leaves no dump, so the hardware path is one source of the noise and a run
// avoids it by asking for software.
export const BROWSER_GPU_ARGS = ["--no-browser-gpu"] as const

// What a run may be told beyond its argv. `jobDir` is both the working directory and the root the browser cache link is
// made under; `network` is the presenter's permission and never a default; the environment and the timeout are the
// adapter's own business, kept per call so the runner can refuse a name the adapter did not declare.
export interface HyperframesRunOptions {
  readonly jobDir: string
  readonly network?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly browserCache?: boolean
}

// The one way a video call reaches the engine. It names the program the adapter declared, passes the argv untouched,
// runs in the job, and hands the environment the adapter owns; the runner decides whether any of that is allowed.
// `browserCache` is off for verbs that start no browser (`lint`), because a link nothing reads is a directory the job
// did not need.
export async function hyperframesRun(
  run: HostRunner,
  args: readonly string[],
  opts: HyperframesRunOptions,
): Promise<HostRunResult> {
  if (opts.browserCache !== false) ensureBrowserCache(opts.jobDir)
  return run.run({
    exe: "hyperframes",
    args: [...args],
    cwd: resolve(opts.jobDir),
    ...(opts.network === true ? { network: true } : {}),
    env: opts.env ?? HYPERFRAMES_ENV,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The envelopes the engine prints.

// The JSON envelope a command prints, or nothing. The CLI writes its progress to stderr and the envelope to stdout, but
// a future version could frame it with a line, so the first object is taken rather than demanding that stdout be JSON
// from its first byte.
export function envelopeOf(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

export const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// What a run said, both streams, for the message a reader gets. The whole output is kept because the JSON envelope is
// the report and the stderr tail is where a refusal that never became JSON is.
export const outputOf = (result: HostRunResult): string =>
  [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n")

// What a `lint` or `check` run concluded. `ok` is the envelope's own verdict, not the exit code's: a run that exits zero
// while printing a failure envelope is still a failure. A refusal and an unparseable envelope are both `ok: false` with
// the reason in `refused`, never a throw, so a caller's report can carry the sentence.
export interface HyperframesReport {
  readonly ok: boolean
  readonly report?: unknown
  readonly output: string
  readonly refused?: string
}

// One part of the check envelope. Every section has the same shape: a verdict, three counts and a `findings` array of the
// same object — `code`, `severity`, `message`, `selector`. The parts differ in the extras (`layout` carries `samples`,
// `contrast` carries `checked`/`passed` and whether it ran at all), so the extras stay a record and the three common
// fields are read once. A finding that is not an object is dropped rather than guessed at: it cannot be reported.
export interface Finding {
  readonly code: string
  readonly severity: string
  readonly message: string
  readonly selector?: string
}

export interface Part {
  readonly ok: boolean
  readonly findings: readonly Finding[]
  readonly fields: Record<string, unknown>
}

export function partOf(report: unknown, key: string): Part | undefined {
  const section = recordOf(recordOf(report)?.[key])
  if (section === undefined) return undefined
  const findings: Finding[] = []
  const listed = section["findings"]
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const item = recordOf(entry)
      if (item === undefined) continue
      findings.push({
        code: typeof item["code"] === "string" ? item["code"] : "unknown",
        severity: typeof item["severity"] === "string" ? item["severity"] : "error",
        message: typeof item["message"] === "string" ? item["message"] : "",
        ...(typeof item["selector"] === "string" ? { selector: item["selector"] } : {}),
      })
    }
  }
  return { ok: section["ok"] === true, findings, fields: section }
}

export const numberIn = (part: Part, key: string): number | undefined => {
  const value = part.fields[key]
  return typeof value === "number" ? value : undefined
}

// The reported sample moments count as a list in the real envelope (`layout.samples` is the seconds the pass looked at),
// and a field that is a list is counted rather than rendered: the sentence wants "in 9 samples", not the seconds.
export const listLengthIn = (part: Part, key: string): number | undefined => {
  const value = part.fields[key]
  return Array.isArray(value) ? value.length : undefined
}

// Where a finding is, in the reader's terms: the selector the browser matched, or the page when the finding is about the
// page itself. This is the closest the envelope comes to "which scene": both writers name every scene's section, so a
// layout or contrast finding's selector begins with the scene it is on.
const addressOf = (finding: Finding): string => (finding.selector ? `${finding.selector}: ` : "")

export const describeFinding = (finding: Finding): string =>
  `${addressOf(finding)}${finding.message || finding.code}`

// How many findings a failed check names before it says how many more there are. A report is read once and fixed from
// one example; eighty findings in one sentence is a wall that hides the first.
export const NAMED_FINDINGS = 3

export function firstFew(findings: readonly Finding[]): string {
  const shown = findings.slice(0, NAMED_FINDINGS).map(describeFinding).join("; ")
  const rest = findings.length - Math.min(findings.length, NAMED_FINDINGS)
  return rest > 0 ? `${shown}; and ${rest} more` : shown
}

export const many = (count: number, one: string, plural = `${one}s`): string =>
  `${count} ${count === 1 ? one : plural}`

// `hyperframes check --json` in the job directory: one browser session that runs lint, runtime, layout, motion and
// contrast. The deck and the video both read the same envelope, so the verb lives here and each adapter maps the
// sections its own checks are about.
export async function hyperframesCheck(run: HostRunner, jobDir: string): Promise<HyperframesReport> {
  const result = await hyperframesRun(run, ["check", "--json", ...BROWSER_GPU_ARGS], { jobDir })
  const output = outputOf(result)
  if (result.refused) return { ok: false, output, refused: result.refused }

  const report = envelopeOf(result.stdout)
  if (report === undefined) {
    return {
      ok: false,
      output,
      refused: `hyperframes check --json printed no JSON envelope${result.passed ? "" : ` (exit ${result.code})`}`,
    }
  }
  const verdict = recordOf(report)
  return { ok: result.passed && verdict?.["ok"] === true, report, output }
}

// `hyperframes lint --json`: the static pass on its own, with no browser. `check` embeds the same lint section, so an
// adapter that has already run `check` should read it from there; this is for a caller that wants the verb by itself.
export async function hyperframesLint(run: HostRunner, jobDir: string): Promise<HyperframesReport> {
  const result = await hyperframesRun(run, ["lint", "--json"], { jobDir, browserCache: false })
  const output = outputOf(result)
  if (result.refused) return { ok: false, output, refused: result.refused }

  const report = envelopeOf(result.stdout)
  if (report === undefined) {
    return {
      ok: false,
      output,
      refused: `hyperframes lint --json printed no JSON envelope${result.passed ? "" : ` (exit ${result.code})`}`,
    }
  }
  const verdict = recordOf(report)
  return { ok: result.passed && verdict?.["ok"] === true, report, output }
}

export interface HyperframesSnapshot {
  readonly shots: readonly string[]
  readonly output: string
}

// What a snapshot was asked for. `at` is the moments; `end` is the CLI's end-of-timeline frame, which is on by default
// there and off here when a caller has already named every scene. One frame per scene is the point of a per-scene
// snapshot: an extra frame at 47.75 s is a scene the artifact does not have, and a check counting frames against scenes
// would call a correct artifact wrong.
export interface HyperframesSnapshotOptions {
  readonly at?: readonly number[]
  readonly end?: boolean
}

// `hyperframes snapshot --json`, with `--at` when the caller named the moments. The paths are what the CLI reported, in
// the form it reported them (this version prints them absolute, under the project's `.hyperframes/artifacts`), because
// rewriting a path the CLI already resolved would hide where the file really is. A refusal or an unreadable envelope
// yields no shots and the output carries the reason: there is no shot to invent.
export async function hyperframesSnapshot(
  run: HostRunner,
  jobDir: string,
  opts: HyperframesSnapshotOptions = {},
): Promise<HyperframesSnapshot> {
  const args = ["snapshot", "--json", ...BROWSER_GPU_ARGS]
  if (opts.end === false) args.push("--no-end")
  const at = opts.at
  if (at !== undefined) {
    if (at.length === 0 || at.some((second) => !Number.isFinite(second) || second < 0)) {
      return { shots: [], output: `hyperframes: --at takes non-negative seconds, got ${JSON.stringify(at)}` }
    }
    args.push("--at", at.map(numberText).join(","))
  }

  const result = await hyperframesRun(run, args, { jobDir })
  const output = outputOf(result)
  if (result.refused) return { shots: [], output }

  const envelope = recordOf(envelopeOf(result.stdout))
  const frames = envelope?.["frames"]
  if (!Array.isArray(frames)) return { shots: [], output }
  const shots: string[] = []
  for (const frame of frames) {
    const path = recordOf(frame)?.["path"]
    if (typeof path === "string" && path.length > 0) shots.push(path)
  }
  return { shots, output }
}

// A time as the CLI's `--at` accepts it: milliseconds kept, trailing zeros dropped, so the same spec always asks for the
// same moments and a snapshot's file names are stable across runs.
export const numberText = (value: number): string => String(Math.round(value * 1000) / 1000)

// ---------------------------------------------------------------------------------------------------------------------
// The two server verbs: `present` (a deck) and `preview` (the studio a video is edited in). Both are local HTTP servers
// that hold the runner until the caller cancels, so the start is bounded and the answer is whether the port came up —
// never a promise that waits for a process nobody is going to stop.

// How long a server is given to answer and how often the port is tried. The server is a few hundred milliseconds on this
// machine; twelve seconds is generous for a cold start and short enough that a broken run fails a test instead of
// hanging it.
const START_MS = 12_000
const POLL_MS = 100
const CONNECT_MS = 400

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// A free TCP port: bind 0, read the number the kernel chose, close, hand the number over. A server needs a port and a
// fixed one collides with whatever else the user is running; the close before the hand-off leaves the small race every
// port probe has, and the server's own start check is what reports a lost one.
export function freePort(label: string): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once("error", (error) =>
      fail(new Error(`${label}: could not find a free port: ${error instanceof Error ? error.message : String(error)}`)),
    )
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) done(port)
        else fail(new Error(`${label}: the free port probe answered with no port`))
      })
    })
  })
}

// Whether something accepts a TCP connection on the port. A server's page is a normal HTTP server, so a connection is
// the cheapest proof it is up; the caller fetches the page itself when it wants the body.
function portAnswers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port })
    let finished = false
    const finish = (answer: boolean): void => {
      if (finished) return
      finished = true
      socket.destroy()
      done(answer)
    }
    socket.setTimeout(CONNECT_MS, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

export interface HyperframesServerStart {
  readonly started: boolean
  readonly output: string
}

// Start a server run and return once the port answers. The run itself is not awaited: the runner is one-run-at-a-time by
// design, so a server occupies it until the caller calls `run.cancel()`, and a function that awaited the server would
// never return. That is the contract both adapters rely on — the server is the job's foreground, and cancelling it is how
// the job ends.
//
// `start` is a function rather than a run input so each adapter can reach the runner its own way: the deck's presenter
// asks the runner directly (its argv has no browser in it), while a video's preview goes through `hyperframesRun` like
// every other video call.
//
// On a timeout the run is cancelled here, because a caller that got `started: false` has no process to cancel and the
// runner would otherwise stay busy. On a refusal nothing is started and the sentence is the output.
export async function hyperframesServe(
  run: HostRunner,
  start: () => Promise<HostRunResult>,
  port: number,
  command: string,
): Promise<HyperframesServerStart> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { started: false, output: `${command}: port ${JSON.stringify(port)} is not a TCP port` }
  }

  let settled: HostRunResult | undefined
  let failed: string | undefined
  // Both halves are handled, so the promise this function leaves behind can never become an unhandled rejection: the run
  // resolves when the caller cancels, and a runner that throws instead is still a start that did not happen.
  const pending = start().then(
    (result) => {
      settled = result
      return result
    },
    (error: unknown) => {
      failed = error instanceof Error ? error.message : String(error)
      return undefined
    },
  )

  const deadline = Date.now() + START_MS
  while (Date.now() < deadline && settled === undefined && failed === undefined) {
    if (await portAnswers(port)) return { started: true, output: `${command} is listening on port ${port}` }
    await wait(POLL_MS)
  }

  if (settled === undefined && failed === undefined) {
    // The port never answered and the process is still alive: stop it so the runner is free, then report what it said.
    run.cancel()
  }
  const result = settled ?? (await pending)
  const said = result ? outputOf(result) : ""
  const why =
    failed ??
    result?.refused ??
    (result?.cancelled ? `${command} was stopped before it answered` : `${command} did not answer on port ${port}`)
  return { started: false, output: said ? `${why}\n${said}` : why }
}

