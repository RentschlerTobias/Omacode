// The adapter interface (B1-T4): what an artifact producer is, and the only description of one the rest of the plugin
// may rely on. A spec (B1-T1) says what to make, a checks registry (B1-T2) says what can be said about it, provenance
// (B1-T3) says what it was made from; an adapter is the code that turns the first into files, and the host runner
// (B1-T5) is the harness that runs the adapter's tools outside the worker sandbox. This file is the seam between them.
//
// An adapter never spawns anything itself. It asks `ctx.run`, and the runner decides what may run where — this package
// cannot enforce an allowlist from inside the process it would be constraining. What this file can do is keep the
// declaration honest: `executablesOf` and `networkOf` validate before they answer, and the runner is meant to ask those
// two rather than read `adapter.executables` or `adapter.network` directly, so no caller ever acts on a field taken off
// an object nobody checked.
//
// The allowlist and the network declaration are code constants on the adapter, and nothing in a spec can add to them: a
// spec carries no executable, no argument and no URL. Nor can it add a check — `check` is handed the definitions it was
// asked to run and returns their results; a result for an id it was not given is refused by `evaluate` (B1-T2), once,
// in one place, and this file does not duplicate that rule.

import type { CheckDef, CheckResult } from "./checks.ts"
import { ARTIFACT_KINDS, type ArtifactKind, type Spec } from "./spec.ts"

// What the runner is asked to run: a program and its arguments, never a command line. There is no string here to split,
// so there is nothing for a quote, a pipe or a semicolon in a spec to argue with.
export interface HostRunInput {
  readonly exe: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly timeoutMs?: number
  // This call needs the host's network, where the adapter declared `network: true`. A call may narrow that declaration
  // (ask `false` and be wrapped anyway) but never widen it: asking for a network the adapter did not declare is a
  // refusal, not a hint. The flag lives in the adapter's code, never in a spec, so a spec still cannot reach out.
  readonly network?: boolean
  // Values for environment names the adapter declared in its meta. A name the adapter did not declare is refused — this
  // is how a deck tells HyperFrames that it is inside a sandbox, so Chrome stops trying to build a second one on top.
  readonly env?: Readonly<Record<string, string>>
}

// What came back. The exit code is carried for the report, and the runner's own verdict sits beside it: a run that timed
// out or lost the end of its output leaves a code that no check should read as a pass on its own.
export interface HostRunResult {
  readonly passed: boolean
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly truncated: boolean
  // Why the runner did not start the program at all: the executable is not on the adapter's allowlist, an argument
  // names a path outside the job directory, another run is active. A refusal is a result and not a throw, because it is
  // a policy answer the adapter handles like any other non-zero run instead of an exception that crashes the job.
  readonly refused?: string
  // The caller's `cancel()` stopped this run. It is its own flag because a closed window is not a program that failed,
  // and a report that cannot tell the two apart blames the renderer for the user's choice.
  readonly cancelled?: boolean
}

// The only way an adapter reaches a program. `run` returns a verdict rather than a child process, and `cancel` is the
// kill switch a closed window or a cancelled job needs. The adapter never spawns anything itself: it asks the runner,
// and the runner is the only place that decides what may run where.
export interface HostRunner {
  run(input: HostRunInput): Promise<HostRunResult>
  cancel(): void
}

// Everything an adapter gets. `jobDir` is the one directory it may write, and every path it hands back (`outputs`,
// `shots`) is relative to it, because that is the form the manifest (B1-T3) and the runner (B1-T5) both resolve.
// `specPath` is the copy the runner validated, so an adapter that hashes its input hashes the bytes the gate saw.
// `signal` is the cooperative half of the kill switch: the runner still kills a process that overstays, but a long
// render should stop at its next await rather than finish work nobody will look at.
export interface AdapterContext {
  readonly jobDir: string
  readonly specPath: string
  readonly run: HostRunner
  readonly log: (line: string) => void
  readonly signal?: AbortSignal
}

// What the runner needs to know about an adapter before it runs anything. `executables` is the allowlist, as bare
// program names, and `network` is the one declaration that decides whether a child may reach out at all; both are
// written in the adapter's source, so neither can arrive with a job.
export interface AdapterMeta {
  readonly kind: ArtifactKind
  readonly name: string
  readonly version: string
  readonly executables: readonly string[]
  readonly network: boolean
  // The environment names the adapter's program needs set, e.g. a tool's own switch for running under a sandbox.
  // Naming one here is permission to read it from the host; the value a run hands it is the adapter's own business and
  // is passed per call (`HostRunInput.env`). A spec can reach neither the name nor the value.
  readonly env?: readonly string[]
}

// The steps an artifact goes through. `prepare` may read the spec and lay out what it needs; `render` is the expensive
// one; `snapshot` produces what the visual checks look at; `check` runs the mechanical ones; `openEditor` is the human's
// door (L3, B1-T2) and `cancel` the way out of a run that will not finish. The optional two are optional because a
// headless artifact (an image set) has no editor to open, while admitting that a missing `render` would be an adapter
// that cannot make anything at all.
export interface Adapter<S extends Spec = Spec> extends AdapterMeta {
  prepare(spec: S, ctx: AdapterContext): Promise<{ readonly notes?: readonly string[] }>
  render(ctx: AdapterContext): Promise<{ readonly outputs: readonly string[] }>
  snapshot(ctx: AdapterContext): Promise<{ readonly shots: readonly { readonly path: string; readonly label: string }[] }>
  check(ctx: AdapterContext, defs: readonly CheckDef[]): Promise<readonly CheckResult[]>
  openEditor?(ctx: AdapterContext): Promise<void>
  cancel?(): Promise<void> | void
}

// A program name, not a path and not a command line: lowercase, starting with a letter or a digit, then letters,
// digits, ".", "_" or "-". No "/" (so "/bin/sh" is not a name the runner would resolve), no space (so "node --version"
// cannot arrive as a single entry) and no leading "-" (so an argument cannot pose as a program).
const BARE_NAME = /^[a-z0-9][a-z0-9._-]*$/

// A shell in the allowlist would turn an argv array back into a command string: the adapter declares "bash", the runner
// runs it, and every argument the runner was careful to keep separate becomes a word in a script. So shells, `env`
// (which exists to launch another program), `xargs` (which builds a command line) and `sudo` (which changes who the
// program runs as) are refused by name. The comparison drops a trailing extension, because "bash.exe" is the same
// shell.
const REFUSED_EXECUTABLES = ["sh", "bash", "zsh", "dash", "ksh", "fish", "env", "xargs", "sudo"] as const

const isShell = (name: string): boolean => {
  const base = name.split(".")[0] ?? name
  return (REFUSED_EXECUTABLES as readonly string[]).includes(base)
}

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)
const got = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

// Refuse an adapter the runner could not safely drive. Everything here is a mistake in code, not in data, so it throws
// instead of returning errors, and the message names the offender: the reader is the person writing the adapter. This
// is also the one place that says what a complete adapter is, so `executablesOf` and `networkOf` cannot each learn a
// different half of it.
export function assertAdapter(adapter: Adapter): void {
  // Validated through an untyped view: the point of this function is what the object really holds, not what its type
  // claims it holds, and a caller that reached the runner through a cast gets the same refusal.
  if (typeof adapter !== "object" || adapter === null) {
    throw new Error(`adapter: expected an object, got ${got(adapter)}`)
  }
  const meta = adapter as unknown as Record<string, unknown>

  const name = meta["name"]
  if (typeof name !== "string" || !name) throw new Error("adapter: name: expected a non-empty string")
  const label = `adapter "${name}"`

  const version = meta["version"]
  if (typeof version !== "string" || !version) throw new Error(`${label}: version: expected a non-empty string`)

  const kind = meta["kind"]
  if (typeof kind !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`${label}: kind must be one of ${ARTIFACT_KINDS.join(", ")}, got ${shown(kind)}`)
  }

  const executables = meta["executables"]
  if (!Array.isArray(executables) || executables.length === 0) {
    throw new Error(
      `${label}: executables: expected at least one program name, got ${Array.isArray(executables) ? "an empty array" : got(executables)}`,
    )
  }
  for (const entry of executables) {
    if (typeof entry !== "string" || !BARE_NAME.test(entry)) {
      throw new Error(`${label}: executable ${shown(entry)}: expected a bare program name matching ${BARE_NAME.source}`)
    }
    if (isShell(entry)) {
      throw new Error(
        `${label}: executable ${shown(entry)}: a shell may not be declared, because it would turn the runner's argv array back into a command string`,
      )
    }
  }

  if (typeof meta["network"] !== "boolean") {
    throw new Error(`${label}: network: expected a boolean, got ${got(meta["network"])}`)
  }

  // The names a run may hand a value for. A malformed or doubled name is a mistake this file can see, so it is refused
  // here rather than becoming a refusal inside the runner at the moment a check needs it.
  const env = meta["env"]
  if (env !== undefined && (!Array.isArray(env) || !env.every((name) => typeof name === "string" && /^[A-Z_][A-Z0-9_]*$/.test(name)))) {
    throw new Error(`${label}: env: expected an array of names like DECK_SWITCH, got ${got(env)}`)
  }
  if (Array.isArray(env) && new Set(env).size !== env.length) throw new Error(`${label}: env: a name appears twice`)

  // The four steps an adapter must have. Naming the missing one is the whole diagnosis: "not an adapter" would leave
  // the reader comparing their object against this file.
  for (const step of ["prepare", "render", "snapshot", "check"] as const) {
    if (typeof meta[step] !== "function") throw new Error(`${label}: ${step}: expected a function, got ${got(meta[step])}`)
  }
  // The two a headless artifact may legitimately lack. Present-but-not-a-function is still a mistake, because the runner
  // would try to call it.
  for (const step of ["openEditor", "cancel"] as const) {
    const value = meta[step]
    if (value !== undefined && typeof value !== "function") {
      throw new Error(`${label}: ${step}: expected a function or absent, got ${got(value)}`)
    }
  }
}

// The allowlist the runner reads. Validated first, because an unvalidated list is only an array of strings, and copied
// and frozen after, because the adapter still holds its own array: a later push must not widen a list the runner has
// already been handed, and a caller must not add to the copy either. This is the only path from an adapter to the
// runner's allowlist.
export function executablesOf(adapter: Adapter): readonly string[] {
  assertAdapter(adapter)
  return Object.freeze([...adapter.executables])
}

// The network declaration, asked the same way, so the runner never reads a field off an object it has not validated and
// a rule added to `assertAdapter` reaches every caller at once.
export function networkOf(adapter: Adapter): boolean {
  assertAdapter(adapter)
  return adapter.network
}
