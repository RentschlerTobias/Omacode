// The host runner (B1-T5): the harness that executes a program an adapter declared, on the user's machine, outside the
// worker sandbox. Renderers cannot run in that sandbox — a Chromium, a HyperFrames process, a ComfyUI worker needs the
// user's desktop and GPU — so this is the one place where a program chosen by an adapter really runs. It is an
// allowlist, not a shell:
//
// - the program is a bare name that must be exactly one entry the adapter declared in code, and the runner resolves it
//   itself; there is no command string here to re-split, no `PATH` lookup the child does on its own, and no shell;
// - the arguments are an array that reaches `spawn` as an array. A quote, a pipe or a semicolon is one character inside
//   one argument, which is the whole reason an argv array is the interface (adapter.ts);
// - the working directory, and every argument that names a path, stays inside the job directory after symlinks are
//   resolved (paths.ts). An interpreter can still read what its code says — the path check sees argv, not argv's meaning
//   — and that residue is why the environment is cleaned and the network cut below;
// - the environment starts from `cleanEnv` (the sandbox's allowlist, no inherited secrets), and the four variables a
//   renderer writes into are overridden to places in the job;
// - without an explicit network declaration the program runs under bubblewrap with the network unshared, and its children
//   inherit both the working directory and the network namespace. With no runnable bubblewrap the runner refuses rather
//   than run an unwrapped child, the same fail-closed rule as A1's sandbox;
// - one run at a time, a timeout capped at half an hour, an output cap that keeps the end of each stream (an error is
//   there), and a cancel that kills the process group so a Chromium's helpers die with it.
//
// B6-T6 extends this (socket auth, daemon input validation); it does not introduce the rules above, and nothing here is
// meant to be widened by a spec. `hostRunnerFor` is the only path from an adapter to an allowlist.

import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import { DENY_READ, HOME, cleanEnv, looksSecret, neverHanded } from "@omacode/sandbox/sandbox"

import {
  executablesOf,
  networkOf,
  type Adapter,
  type HostRunInput,
  type HostRunResult,
  type HostRunner,
} from "./adapter.ts"
import { insidePath, realish } from "./paths.ts"

export type { HostRunInput, HostRunResult, HostRunner } from "./adapter.ts"

// The options a runner is built with. `allow` and `network` are the adapter's declaration, copied out of a validated
// adapter by `hostRunnerFor`; everything else is the host's part (where the job is, which bubblewrap binary, how patient
// and how much output). A caller can narrow the rules here, never widen the two that came from the adapter.
export interface HostRunnerOptions {
  readonly allow: readonly string[]
  readonly jobDir: string
  readonly network: boolean
  // The search path for the executable. Omitted means the system directories and the process's own PATH.
  readonly path?: readonly string[]
  // Names `cleanEnv` may add for this run. A secret-looking name is refused here (rule e), not silently dropped.
  readonly env?: readonly string[]
  // The directories and files the sandbox hides while the network is unshared. Omitted means the sandbox's DENY_READ.
  readonly denyRead?: readonly string[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  // The bubblewrap binary, or false to say this host has none. `false` with `network: false` refuses every run.
  readonly bwrap?: string | false
}

// Everything about a run except starting it, so the rules can be tested on their own and the sentence a refusal would
// carry can be read without a child process. The fields describe what `spawn` would be handed.
export interface HostRunReady {
  readonly ok: true
  readonly exe: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly wrapper: readonly string[]
}

export interface HostRunRefused {
  readonly ok: false
  readonly refused: string
}

export type HostRunCheck = HostRunReady | HostRunRefused

// A program name, not a path and not a command line. The same shape adapter.ts refuses to declare, checked again here
// because this function is exported: "/bin/sh" has a separator, "node --version" has a space, and a leading "-" would let
// an argument pose as the program.
const BARE_NAME = /^[a-z0-9][a-z0-9._-]*$/

// The names `cleanEnv` may add. An environment variable is not a place for a lower-case or puny name: it would not be
// the same variable in a shell, and a renderer reading it would get a different one than the adapter set.
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

// Where a program is looked for when the caller names no search path: the system's own directories first, then the
// process's PATH. Only the program name is resolved; the child never does a PATH lookup for the program itself.
const SYSTEM_DIRS: readonly string[] = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

// A URL is an argument a renderer may legitimately take and is not a path, so it is not resolved against the job. The
// scheme is required: "example.com/x" is a relative path, not a URL.
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i

const DEV_NULL = "/dev/null"
const DEFAULT_TIMEOUT_MS = 300_000
// Half an hour. A render may be slow; a run nobody is waiting for anymore must still end, and a number a caller cannot
// make larger keeps one wedged renderer from holding the job forever.
const MAX_TIMEOUT_MS = 1_800_000
const DEFAULT_MAX_OUTPUT_BYTES = 65_536

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const refused = (why: string): HostRunRefused => ({ ok: false, refused: why })

// The search path the runner uses, with every directory inside the job dropped: a `node` planted in the job must not be
// found, because "the adapter declared node" means the machine's node, not a file the job (or a spec that made it)
// wrote. An empty entry means the current directory in a shell's PATH, which is not a place to find a program either.
function searchDirs(jobDir: string, named?: readonly string[]): string[] {
  const raw = named ?? [...SYSTEM_DIRS, ...(process.env.PATH ?? "").split(":")]
  const dirs: string[] = []
  for (const dir of raw) {
    if (!dir) continue
    if (insidePath(jobDir, dir)) continue
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

// A name looked up in the search path: a regular file with an execute bit, or nothing. `statSync` follows a symlink, so
// a distribution's /usr/bin/node -> ../lib/node keeps working — but the file it finally names must still be outside the
// job. A search directory that is writable by the user (a ~/.local/bin in PATH) could otherwise hold a symlink a job
// planted there, which would pass the directory check and run the job's own program anyway.
function findProgram(name: string, dirs: readonly string[], jobDir: string): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      const info = statSync(candidate)
      if (!info.isFile() || (info.mode & 0o111) === 0) continue
      if (insidePath(jobDir, candidate)) continue
      return candidate
    } catch {
      // Not here; the next directory may have it.
    }
  }
  return undefined
}

// The bubblewrap binary, when the host has one. An explicit path with a separator is taken as written (it is the host's
// choice, not a job's); a bare name goes through the same search path the program did. `false` says there is none.
function findBwrap(option: string | false | undefined, dirs: readonly string[], jobDir: string): string | undefined {
  if (option === false) return undefined
  const name = option ?? "bwrap"
  if (name.includes("/")) {
    const path = realish(name)
    try {
      const info = statSync(path)
      return info.isFile() && (info.mode & 0o111) !== 0 ? path : undefined
    } catch {
      return undefined
    }
  }
  return findProgram(name, dirs, jobDir)
}

// "~" as the sandbox writes it, expanded to the real home, because bubblewrap takes absolute paths.
function homePath(entry: string): string {
  if (entry === "~") return HOME
  if (entry.startsWith("~/")) return join(HOME, entry.slice(2))
  return entry
}

// Whether an argument names a path, and the absolute path it names. A URL is not a path; an absolute path is taken as
// it is; a relative one is resolved against the working directory. A bare word ("slide-1") is not path-like, and "."
// or ".." is a directory even without a separator.
function namedPath(value: string, cwd: string): string | undefined {
  if (URL_LIKE.test(value)) return undefined
  if (isAbsolute(value)) return value
  if (value === "." || value === ".." || value.includes("/")) return resolve(cwd, value)
  return undefined
}

// The rules, in the order a reader would try them: the program, where it is, where it runs, what it is handed, what it
// runs with, and what wraps it. Every refusal is a sentence naming the value that failed, because that sentence is what
// an adapter's report and the user read.
export function resolveHostRun(input: HostRunInput, options: HostRunnerOptions): HostRunCheck {
  const jobDir = realish(options.jobDir)

  // a. The program is one bare name the adapter declared. Not a path ("/bin/sh"), not a command line ("node --version"),
  // and not simply any installed program: the allowlist is code in the adapter, and it is the only reason the runner
  // knows a name at all.
  if (typeof input.exe !== "string" || !BARE_NAME.test(input.exe)) {
    return refused(`executable ${shown(input.exe)} is not one bare program name, so the runner will not look it up`)
  }
  if (!options.allow.includes(input.exe)) {
    return refused(`executable ${shown(input.exe)} is not on this adapter's allowlist (${options.allow.join(", ") || "empty"})`)
  }

  // b. Where the program is, resolved by the runner rather than by the shell the child does not have.
  const dirs = searchDirs(jobDir, options.path)
  const exe = findProgram(input.exe, dirs, jobDir)
  if (!exe) {
    return refused(`executable ${shown(input.exe)} was not found in ${dirs.join(", ") || "the empty search path"}`)
  }

  // c. Where it runs: the job directory unless a subdirectory of it was named. The real path must exist and be a
  // directory, because `cwd` is not a hint — a child that starts nowhere runs in the runner's own directory.
  const namedCwd = input.cwd ?? jobDir
  if (typeof namedCwd !== "string" || !namedCwd) {
    return refused(`cwd ${shown(namedCwd)} is not a directory inside the job`)
  }
  const cwd = realish(isAbsolute(namedCwd) ? namedCwd : join(jobDir, namedCwd))
  let cwdInfo
  try {
    cwdInfo = statSync(cwd)
  } catch {
    return refused(`cwd ${shown(namedCwd)} does not exist inside the job directory`)
  }
  if (!cwdInfo.isDirectory()) {
    return refused(`cwd ${shown(namedCwd)} is not a directory inside the job`)
  }
  if (!insidePath(jobDir, cwd)) {
    return refused(`cwd ${shown(namedCwd)} is outside the job directory`)
  }

  // d. What it is handed. Every argument is one string with no NUL, and every argument that names a path stays in the
  // job after resolution. For "--flag=value" the value is the path, not the flag. The check is on the real path, so a
  // symlink inside the job that points out is refused even though its name is harmless. An argument that is not
  // path-shaped is not read as a path: the runner sees argv, not what an interpreter will do with it.
  const args: string[] = []
  for (const [index, arg] of input.args.entries()) {
    if (typeof arg !== "string") {
      return refused(`argument ${index} is not a string, and every argument is one argv entry`)
    }
    if (arg.includes("\0")) {
      return refused(`argument ${index} holds a NUL, which one argv entry cannot carry`)
    }
    const eq = arg.startsWith("-") ? arg.indexOf("=") : -1
    const value = eq > 0 ? arg.slice(eq + 1) : arg
    const path = namedPath(value, cwd)
    if (path !== undefined && !insidePath(jobDir, path)) {
      return refused(`argument ${index} ${shown(arg)} names a path outside the job directory (${realish(path)})`)
    }
    args.push(arg)
  }

  // e. What it runs with. The names the adapter asked for are validated first: a secret in an environment variable is
  // still a secret when the variable is a renderer's, and a socket into the desktop is the same door whatever the
  // program is. Then `cleanEnv` decides the rest from the sandbox's own allowlist and never list, and the four
  // variables a renderer writes to are moved into the job — a Chromium profile and a temp file belong to the job, not
  // to the user's home or to a shared /tmp.
  const granted = options.env ?? []
  for (const name of granted) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      return refused(`environment name ${shown(name)} must match ${ENV_NAME.source}`)
    }
    if (neverHanded(name)) {
      return refused(`environment name ${shown(name)} is never handed on, whatever the adapter asks`)
    }
    if (looksSecret(name)) {
      return refused(`environment name ${shown(name)} looks like a secret, so it is not handed to a renderer`)
    }
  }
  // The values a call hands for the names the adapter declared. They are checked like the names themselves — a declared
  // name is still not a licence to smuggle a secret, and a name nobody declared is refused above — and then laid over
  // `cleanEnv`, so a tool can be told "you are the one inside the sandbox" without a global environment variable.
  const values = input.env ?? {}
  for (const name of Object.keys(values)) {
    if (!granted.includes(name)) {
      return refused(`environment name ${shown(name)} is set by this run but not declared by its adapter`)
    }
  }
  const env = { ...cleanEnv(process.env, granted), ...values }
  const home = join(jobDir, ".home")
  const temp = join(jobDir, ".tmp")
  env.HOME = home
  env.TMPDIR = temp
  env.TMP = temp
  env.TEMP = temp
  env.PATH = dirs.join(":")

  // f. What wraps it. With no network declaration the child runs under bubblewrap with the network namespace unshared:
  // the host is read-only except the job, /dev is available, and the denied directories and files are hidden. A child
  // (a Chromium's renderer, a helper) inherits the namespace and the working directory, so the restriction reaches it.
  //
  // If bubblewrap cannot run, the run is refused. An unwrapped child would have the network this rule exists to remove,
  // and "the sandbox was missing" is not a reason to hand a renderer the user's network — the same fail-closed rule as
  // A1's sandbox.
  //
  // A run that asks for the network and is allowed it is not wrapped at all: `denyRead` is not applied either, because
  // it is bubblewrap's mount list. That is the documented consequence — a networked presenter sees what the user's own
  // processes see, which is what makes its localhost page reachable from the user's browser.
  const wrapper: string[] = []
  // A run reaches the host network only when the adapter both declared it and this call asks for it. The declaration
  // alone is a permission, not a default: a deck adapter declares it for its presenter, and its check still runs wrapped,
  // because a check that forgot to ask is the case that must stay safe. Asking for a network the adapter never declared
  // is a refusal.
  if (input.network === true && options.network !== true) {
    return refused("this adapter did not declare the network, so this run cannot ask for it")
  }
  if (input.network !== true) {
    const bwrap = findBwrap(options.bwrap, dirs, jobDir)
    if (!bwrap) {
      return refused(
        `network is not declared for this adapter, but ${shown(options.bwrap === false ? "bwrap (disabled)" : (options.bwrap ?? "bwrap"))} is not runnable here, so the program would run with the network`,
      )
    }
    // The root first, then /dev on top of it: a later mount shadows an earlier one, and the other order leaves /dev/null
    // read-only inside the sandbox. That is not cosmetic — `spawn` with `stdio: "ignore"` opens /dev/null, and a program
    // that logs to it gets EACCES, so a check would fail with an error that has nothing to do with the deck.
    wrapper.push(bwrap, "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev")
    const denyDirs: string[] = []
    const denyFiles: string[] = []
    for (const entry of options.denyRead ?? DENY_READ) {
      const path = realish(homePath(entry))
      let info
      try {
        info = statSync(path)
      } catch {
        continue // Nothing to hide: a lock file or a key store this machine never made.
      }
      if (info.isDirectory()) denyDirs.push(path)
      else if (info.isFile()) denyFiles.push(path)
    }
    // A directory is emptied by an empty mount over it. A file is hidden by binding the empty device over it: it stays
    // readable as /dev/null, so a program that probes for a config file gets a missing value rather than an error it
    // would report as a broken run.
    for (const dir of denyDirs) wrapper.push("--tmpfs", dir)
    for (const file of denyFiles) wrapper.push("--ro-bind", DEV_NULL, file)
    wrapper.push("--bind", jobDir, jobDir, "--chdir", cwd, "--")
  }

  return { ok: true, exe, args, cwd, env, wrapper }
}

// A tail that keeps the last `max` bytes of one stream. The head of a renderer's log is progress; the end is where the
// failure is, so dropping from the front is the choice that keeps the useful part. Cutting at a byte boundary can split
// a UTF-8 sequence, which shows up as one replacement character: the alternative is guessing where a character starts in
// bytes that may already have been dropped.
function tail(max: number): { push(chunk: Buffer): void; text(): string; truncated: boolean } {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk: Buffer) {
      chunks.push(chunk)
      bytes += chunk.length
      while (bytes > max) {
        truncated = true
        const head = chunks[0]!
        const excess = bytes - max
        if (head.length <= excess) {
          chunks.shift()
          bytes -= head.length
        } else {
          chunks[0] = head.subarray(excess)
          bytes -= excess
        }
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    get truncated() {
      return truncated
    },
  }
}

// One result for a run that never started. `code: -1` is the same value a signal death reports, so an adapter that only
// looked at the code would still see a failure — the `refused` field is what says why.
const notStarted = (why: string): HostRunResult => ({
  passed: false,
  code: -1,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  refused: why,
})

export async function createHostRunner(options: HostRunnerOptions): Promise<HostRunner> {
  // The job directory as the filesystem really has it: one root for the search-path filter, the argument checks, the
  // bubblewrap bind and the home/temp the child gets, so a symlinked job cannot be spelled two ways.
  const jobDir = realish(options.jobDir)
  const settings: HostRunnerOptions = { ...options, jobDir }

  // A renderer writes a browser profile and temp files; both belong to the job and to nobody else, so they are made now,
  // private, and are what HOME and TMPDIR point at.
  mkdirSync(join(jobDir, ".home"), { recursive: true, mode: 0o700 })
  mkdirSync(join(jobDir, ".tmp"), { recursive: true, mode: 0o700 })

  let active: ChildProcess | undefined
  let stopActive: (() => void) | undefined

  const runner: HostRunner = {
    async run(input: HostRunInput): Promise<HostRunResult> {
      // One at a time. The refusal comes before any resolution or spawn, so a second job cannot start a program while
      // the first's children are still alive; `cancel` is how the caller makes room.
      if (active !== undefined) return notStarted("another run is active")

      const check = resolveHostRun(input, settings)
      if (!check.ok) return notStarted(check.refused)

      const max = Math.max(0, settings.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
      const timeoutMs = Math.min(Math.max(1, input.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)

      // The program and its arguments are separate elements, and they stay separate: there is no shell in between, no
      // string to split. The wrapper, when there is one, is prefixed to the same array and ends with "--" so bubblewrap
      // stops reading options and the program is its first operand.
      const [command, argv] =
        check.wrapper.length > 0
          ? [check.wrapper[0]!, [...check.wrapper.slice(1), check.exe, ...check.args]]
          : [check.exe, check.args]

      let child: ChildProcess
      try {
        child = spawn(command, argv, {
          cwd: check.cwd,
          env: check.env,
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so `cancel` and the timeout can kill a Chromium's helpers with it. `detached` here
          // does not mean "outlive the runner": `--die-with-parent` covers the wrapper, and the close handler keeps the
          // promise until the group is gone.
          detached: true,
        })
      } catch (error) {
        return notStarted(`could not start ${shown(check.exe)}: ${reason(error)}`)
      }

      active = child
      return await new Promise<HostRunResult>((finish) => {
        let settled = false
        let timedOut = false
        let cancelled = false
        const out = tail(max)
        const err = tail(max)

        const kill = (): void => {
          if (child.pid === undefined) return
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {
            // No group to signal (or it is already gone): the child itself is the fallback, and a kill that fails
            // because the process exited on its own is the outcome we wanted anyway.
            try {
              child.kill("SIGKILL")
            } catch {
              // Already gone.
            }
          }
        }

        // The kill switch. It kills the group, not the process in front of it, so the window this closes does not leave
        // a browser's children behind; the pending run resolves as cancelled rather than as a failed program.
        const stop = (): void => {
          cancelled = true
          kill()
        }
        stopActive = stop

        let timer: ReturnType<typeof setTimeout> | undefined

        const settle = (code: number | null): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (active === child) active = undefined
          if (stopActive === stop) stopActive = undefined
          finish({
            // A signal death is not a pass, and neither is a run the caller stopped: `code` alone cannot say that.
            passed: !cancelled && !timedOut && code === 0,
            code: code ?? -1,
            stdout: out.text(),
            stderr: err.text(),
            timedOut,
            truncated: out.truncated || err.truncated,
            ...(cancelled ? { cancelled: true } : {}),
          })
        }

        timer = setTimeout(() => {
          timedOut = true
          kill()
        }, timeoutMs)

        child.stdout?.on("data", (chunk: Buffer) => out.push(chunk))
        child.stderr?.on("data", (chunk: Buffer) => err.push(chunk))
        child.on("close", (code) => settle(code))
        // A program the resolver found but the kernel could not start (a race, a bad interpreter line) never reaches
        // "close" with an exit code worth reading. It is still a result, with the reason in stderr.
        child.on("error", (error) => {
          err.push(Buffer.from(`${reason(error)}\n`))
          settle(-1)
        })
      })
    },

    cancel(): void {
      stopActive?.()
    },
  }

  return runner
}

// The one way an adapter reaches a runner: its allowlist and its network declaration come from the validated adapter,
// and they are applied last so a caller's copy of the options cannot widen them. There is no second path from an adapter
// to a program, which is what makes "the program is chosen by code" a property of the package rather than a promise.
export async function hostRunnerFor(
  adapter: Adapter,
  options: Omit<HostRunnerOptions, "allow" | "network">,
): Promise<HostRunner> {
  return createHostRunner({
    ...options,
    allow: executablesOf(adapter),
    network: networkOf(adapter),
    env: [...(options.env ?? []), ...(adapter.env ?? [])],
  })
}
