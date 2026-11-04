// A worker's wait (the tool "wait"): block instead of polling.
//
// A worker that starts a long command has to poll it: `sleep 5` and read the log again. Every poll is a shell command,
// every shell command asks the permission layer again, and the worker is cut by the checkpoint before the command is
// done. The wait tool takes that loop away: one call blocks until the thing it waits for has happened or the timeout
// ticks, and it says what happened when it returns.
//
// What it waits for:
//   - a process (pid): until it is gone;
//   - a file (path): until it has the line (line) or the text (match) it is waiting for;
//   - a paused permission request (id): until it is answered, refused or dropped.
// The permission answer itself is not this tool's job: it only tells the worker how the request ended.
//
// It runs nothing new: it watches, so it needs no permission of its own, and it never writes anything.

import { readFileSync } from "node:fs"

// How long a wait lasts when the caller says nothing. A worker waiting on a build wants more than a moment and less
// than the patience of the user.
export const WAIT_DEFAULT_MS = 60_000
// The longest a wait may block, whatever the caller asks for.
export const WAIT_MAX_MS = 10 * 60_000
// How often a wait looks at what it waits for.
const POLL_MS = 250

export interface WaitRequest {
  readonly id?: string // a paused permission request ("A1") or a short label of one
  readonly pid?: number // a process id
  readonly file?: string // a file or log to watch
  readonly match?: string // the text to wait for in the file
  readonly line?: number // the line count to wait for
  readonly timeoutMs: number
}

export type WaitOutcome = "done" | "timeout" | "failed"

export interface WaitResult {
  readonly outcome: WaitOutcome
  readonly text: string
  readonly waitedMs: number
}

// What the wait watches: the permission request, a process or a file. Exactly one of them.
export interface Watcher {
  // The promise that settles when the thing happened. It never rejects: a watch that cannot start fails at once.
  readonly done: Promise<{ readonly detail: string }>
  // The text of what happened, for the timeout message: what was watched and how far it got.
  readonly progress: () => string
  // The watch stops looking. A wait that timed out calls it, so no timer of it is left running.
  stop?: () => void
}

// Whether a process is still there. A pid the host does not know is a process that is gone: the answer is what the
// worker asked for.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM means it is there but this process may not signal it.
    return (err as NodeJS.ErrnoException)?.code === "EPERM"
  }
  // A process that has exited but is not reaped yet is still a pid the host knows. It is over all the same: nobody
  // waits for a corpse.
  return !zombie(pid)
}

// Whether a process is a corpse waiting to be reaped (Linux keeps its state in /proc).
function zombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // The state is the field after the name in parentheses: "R" runs, "Z" is a corpse.
    const after = stat.slice(stat.lastIndexOf(")") + 1).trim()
    return after.startsWith("Z")
  } catch {
    // No /proc (not Linux) or no such pid: not a corpse.
    return false
  }
}

// A watch on a process: it is done when the process is gone.
export function watchPid(pid: number): Watcher {
  if (!Number.isInteger(pid) || pid <= 0) return failed(`pid ${pid} is no process id`)
  if (!alive(pid)) return { done: Promise.resolve({ detail: `the process ${pid} is already gone` }), progress: () => `process ${pid}` }
  let timer: ReturnType<typeof setInterval> | undefined
  const done = new Promise<{ detail: string }>((resolve) => {
    timer = setInterval(() => {
      if (alive(pid)) return
      clearInterval(timer)
      resolve({ detail: `the process ${pid} has ended` })
    }, POLL_MS)
    timer.unref?.()
  })
  return { done, progress: () => `process ${pid}`, stop: () => { if (timer) clearInterval(timer) } }
}

// A watch on a file: it is done when the file has the line it waits for, or holds the text it waits for. The file may
// not be there yet: a command that writes a log creates it when it starts.
export function watchFile(file: string, match?: string, line?: number): Watcher {
  if (!file) return failed("wait needs a file to watch")
  const path = file.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
  const read = () => {
    try { return readFileSync(path, "utf8") } catch { return undefined }
  }
  const count = (text: string) => {
    // A trailing newline ends the last line, it does not begin a new one.
    const all = text.split("\n")
    return text.endsWith("\n") ? all.length - 1 : all.length
  }
  const hit = (text: string | undefined) => {
    if (text === undefined) return false
    if (match) return text.includes(match)
    if (line !== undefined) return count(text) >= line
    // Nothing to look for: the file has to be there and have something in it.
    return count(text) > 0
  }
  const what = match ? `"${match}" in ${path}` : line !== undefined ? `${line} lines in ${path}` : `${path} to have content`
  if (hit(read())) return { done: Promise.resolve({ detail: `the file ${path} already has it` }), progress: () => what }
  let timer: ReturnType<typeof setInterval> | undefined
  const done = new Promise<{ detail: string }>((resolve) => {
    timer = setInterval(() => {
      const text = read()
      if (!hit(text)) return
      clearInterval(timer)
      resolve({ detail: match ? `the file ${path} holds "${match}"` : line !== undefined ? `the file ${path} has ${count(text!)} lines` : `the file ${path} has content` })
    }, POLL_MS)
    timer.unref?.()
  })
  const progress = () => {
    const text = read()
    const how = match ? `"${match}" in it` : line !== undefined ? `${line} lines in it` : "content in it"
    return text === undefined ? `file ${path} (not there yet, waiting for ${how})` : `file ${path} (${count(text)} lines, waiting for ${how})`
  }
  return { done, progress, stop: () => { if (timer) clearInterval(timer) } }
}

// A watch on a paused permission request: it is done when the request is answered, refused or dropped.
export function watchAsk(settled: Promise<{ readonly id: string; readonly decision: string; readonly by: string; readonly note: string }>, what: string): Watcher {
  const done = settled.then((s) => ({ detail: `the request ${s.id} was ${s.decision === "refuse" ? "refused" : "allowed"} (${s.by})${s.note ? `: ${s.note}` : ""}` }))
  return { done, progress: () => what }
}

function failed(why: string): Watcher {
  return { done: Promise.reject(new Error(why)), progress: () => why }
}

// The wait itself: it blocks until the watch is done or the timeout ticks. It never leaves the caller hanging.
export async function waitFor(watch: Watcher, timeoutMs: number): Promise<WaitResult> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs))
    timer.unref?.()
  })
  try {
    const result = await Promise.race([watch.done, timeout])
    if ("timedOut" in result) {
      return { outcome: "timeout", text: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${watch.progress()}. Nothing happened that the wait could see.`, waitedMs: Date.now() - started }
    }
    return { outcome: "done", text: `Done after ${Math.round((Date.now() - started) / 100) / 10}s: ${result.detail}.`, waitedMs: Date.now() - started }
  } catch (err) {
    return { outcome: "failed", text: `The wait failed: ${err instanceof Error ? err.message : String(err)}`, waitedMs: Date.now() - started }
  } finally {
    if (timer) clearTimeout(timer)
    // A watch that timed out keeps looking otherwise: it stops here.
    watch.stop?.()
  }
}

// The timeout the caller asked for, in milliseconds: a number of seconds, or "60s", or "2m".
export function waitTimeoutMs(raw: string, fallback = WAIT_DEFAULT_MS): number {
  const text = raw.trim().toLowerCase()
  if (!text) return fallback
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text)
  if (!m) return fallback
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return fallback
  const unit = m[2] ?? "s"
  const ms = unit === "ms" ? value : unit === "s" ? value * 1000 : unit === "m" ? value * 60_000 : value * 3_600_000
  return Math.min(Math.round(ms), WAIT_MAX_MS)
}
