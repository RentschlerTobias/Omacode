// The STATE digest: the thread's own snapshot, written before a compaction takes the transcript away.
//
// A long session's context is compacted: old tool results are replaced by stubs, older turns by one summary. What is
// replaced is what the session said; what is not in any tool result is the state the orchestrator built: the job's
// goal, its tasks and where each of them stands, what is still open. That state lives in the job file, but the job
// file is not in the context: after a compaction the orchestrator reads a summary that may not mention the task that
// waits for it. The digest is that state, written out as text before the compaction, so the thread keeps it.
//
// The digest is written where it cannot be lost: the journal (every turn) and the session's digest file (the last one).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The parts of a job a digest needs. The orchestrator's Job/Task are assignable to these, so this package does not
// import the orchestration state.
export interface DigestTask {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly session?: string
  readonly commit?: string
}

export interface DigestJob {
  readonly id: string
  readonly goal: string
  readonly phase: string
  readonly tasks: readonly DigestTask[]
  readonly acceptance: readonly { readonly id: string; readonly text: string }[]
}

export interface DigestState {
  readonly job?: DigestJob
  readonly task?: DigestTask
  readonly sessionID: string
  readonly reason?: string // why the digest was written ("epoch", "summary")
}

// What the job looks like right now, in a few lines: enough to go on without the transcript.
export function digestText(s: DigestState): string {
  const lines: string[] = []
  const job = s.job
  if (job) {
    lines.push(`Job ${job.id}: ${job.goal}`)
    lines.push(`Phase: ${job.phase}. Task ${job.tasks.filter((t) => t.status !== "merged").length} of ${job.tasks.length} not merged.`)
    // Done work is what a fresh context most needs: without it the orchestrator has titles but no outcomes and writes
    // the same plan again. A long job lists the recent tail and counts the rest.
    const done = job.tasks.filter((t) => t.status === "merged" || t.status === "passed")
    if (done.length) lines.push(`Done: ${done.slice(-10).map((t) => `${t.id} ${t.title}${t.commit ? ` (${t.commit})` : ""}`).join("; ")}${done.length > 10 ? `; … and ${done.length - 10} earlier` : ""}`)
    const open = job.tasks.filter((t) => t.status !== "merged" && t.status !== "passed")
    for (const t of open.slice(0, 30)) lines.push(`- ${t.id} ${t.title} [${t.status}]${t.session ? ` (session ${t.session})` : ""}`)
    if (open.length > 30) lines.push(`- … and ${open.length - 30} more open tasks`)
    if (job.acceptance.length) lines.push(`Acceptance: ${job.acceptance.slice(0, 20).map((a) => `${a.id} ${a.text}`).join("; ")}${job.acceptance.length > 20 ? `; … and ${job.acceptance.length - 20} more` : ""}`)
  }
  if (s.task) lines.push(`This session works on ${s.task.id} ${s.task.title} [${s.task.status}].`)
  if (s.reason) lines.push(`Written before a ${s.reason}, so the thread keeps this after the compaction.`)
  return lines.join("\n")
}

// The digest of a session, kept next to its context state, so a later turn can read it back.
export function digestPath(dir: string, sessionID: string): string {
  return join(dir, `${sessionID}.digest.txt`)
}

// Writes the digest where it cannot be lost: the file of the session (the last one) and the journal (every one).
export function writeDigest(s: DigestState, dir: string, journal?: (entry: Record<string, unknown>) => void): string {
  const text = digestText(s)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${digestPath(dir, s.sessionID)}.tmp`, text)
    renameSync(`${digestPath(dir, s.sessionID)}.tmp`, digestPath(dir, s.sessionID))
  } catch {
    // the journal entry below is the other copy
  }
  journal?.({ kind: "context.digest", sessionID: s.sessionID, reason: s.reason ?? "compaction", chars: text.length, job: s.job?.id, task: s.task?.id, text })
  return text
}

// The last digest of a session, read back after a compaction; undefined when there is none.
export function readDigest(dir: string, sessionID: string): string | undefined {
  try {
    const text = readFileSync(digestPath(dir, sessionID), "utf8")
    return text.trim() ? text : undefined
  } catch {
    return undefined
  }
}
