// Automatic merge: a job whose tasks are all merged goes into the user's checkout without the user's ack
// (design.md §12, plus the user's "autoMerge" setting). Runner jobs merge right after their final checks
// (#verify, src/runner.ts); native and rolling jobs when the micromanager's turn ends (src/plugin.ts onIdle).
// merge_job stays the manual path, and undo_merge takes an automatic merge back exactly as it takes a manual one.
//
// It lives apart from plugin.ts and runner.ts so neither of them has to import the other through this.

import { loadSettings } from "./config.ts"
import { exec, mergeIntoCheckout, type Exec } from "./integration.ts"
import { saveJob } from "./store.ts"
import type { Job } from "./state.ts"

// A job in one of these is not running to its end, so nothing merges by itself.
const HALTED: ReadonlySet<Job["phase"]> = new Set(["paused", "ask_user", "stopped", "failed", "done"])

// One merge at a time per job: two idle wakes (or a second plugin instance on the same job) must not both merge.
const merging = new Set<string>()

export interface AutoMergeOutcome {
  readonly merged?: { readonly from: string; readonly to: string; readonly at: string }
  readonly note?: string
  readonly reason?: string
}

export interface AutoMergeOptions {
  readonly run?: Exec
  readonly checks?: readonly string[] // overrides the job's acceptance checks (tests, and a caller that knows better)
  readonly record?: (entry: unknown) => void
}

// The job's acceptance checks, each once: the same gate mergeIntoCheckout runs on the rebased branch.
function acceptanceChecks(job: Job): string[] {
  return [...new Set(job.acceptance.map((a) => a.verify).filter((v): v is string => Boolean(v)))]
}

// A job is complete exactly when nextStep/autoStep call it done: no open or live task is left. A ready or running task
// means there is still work, so an early merge would put half a job into the checkout. merged and cancelled always
// count; a passed task counts only when it has no worktree of its own: its commits are still on the task's branch in
// that case, waiting for the merge train, and merging before it lands would skip its work.
function complete(job: Job): boolean {
  const done = (t: Job["tasks"][number]): boolean => t.status === "merged" || t.status === "cancelled" || (t.status === "passed" && !t.worktree)
  return job.tasks.length > 0 && job.tasks.every(done) && job.tasks.some((t) => t.status === "merged")
}

export async function maybeAutoMerge(project: string, job: Job, opts: AutoMergeOptions = {}): Promise<AutoMergeOutcome> {
  if (!loadSettings().autoMerge) return {}
  if (!job.integrationCheckout || job.integrationCheckout === "HEAD" || !job.integrationBranch || !job.integrationWorktree || !job.integrationBase) return {}
  if (HALTED.has(job.phase)) return {}
  if (!complete(job)) return {}
  // The branch tip the user took back with undo_merge stands until the branch moves again: a new task commit changes
  // the tip, so genuinely new work merges while the undone tip does not come back by itself.
  if (job.mergeUndoneAt) {
    const tip = await (opts.run ?? exec)("git", ["rev-parse", job.integrationBranch], { cwd: job.integrationWorktree })
    if (tip.code === 0 && tip.stdout.trim() === job.mergeUndoneAt) return {}
  }
  if (merging.has(job.id)) return {}
  merging.add(job.id)
  try {
    const result = await mergeIntoCheckout(project, job, {
      checkout: job.integrationCheckout,
      checks: opts.checks ?? acceptanceChecks(job),
      allowDirty: true,
    }, opts.run)
    if (!result.ok) {
      if (result.reason === "nothing") return {}
      const failed = result.checks?.filter((r) => !r.passed).map((r) => r.command) ?? []
      const why = result.detail ? `${result.reason}: ${result.detail}` : result.reason
      return {
        reason: result.reason,
        note: `[micromanager] job ${job.id} was not merged into the checkout automatically (${why}${failed.length ? `: ${failed.join(", ")}` : ""}). Nothing was written; the job's branch is unchanged, and merge_job brings it in when the user says so.`,
      }
    }
    const at = new Date().toISOString()
    const merge = { from: result.from, to: result.to, at }
    job.merges = [...(job.merges ?? []), merge]
    saveJob(project, job)
    opts.record?.({ kind: "merge", job: job.id, branch: job.integrationBranch, auto: true, from: result.from, to: result.to })
    return {
      merged: merge,
      note: `[micromanager] job ${job.id} merged into the checkout automatically (${result.from.slice(0, 7)}..${result.to.slice(0, 7)}); undo_merge takes it back, discard_job removes the branch.`,
    }
  } finally {
    merging.delete(job.id)
  }
}
