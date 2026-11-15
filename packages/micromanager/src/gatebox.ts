// The sandbox a check or a contract's evaluator runs in (A1-T12). Both are host-side `sh -c` commands written by a
// worker (a task's Checks: lines) or by a contract that worker's job carries, and both used to run with the user's full
// rights outside the sandbox every other worker command goes through. A check is promoted from a worktree, so it gets
// the same rules as the worker that wrote it: its own worktree (the plan area for a plan job), the registries and the
// job's grants, and the cleaned environment.
//
// With no sandbox on the machine there is nothing to run a check under; the gate says why (`skip`) and the caller
// reports it instead of executing the command unsandboxed. The one exception is D23 (A1-T14): a job the user confirmed
// for exactly this runs its checks unwrapped, and every result says so (`unsandboxed`), so nothing reads like a
// sandboxed run that was not.

import { cleanEnv, planRules, rulesFor, tempDirFor, withTemp, type Wrapper } from "./sandbox.ts"
import { planRoot } from "./writeguard.ts"

export interface Gate {
  readonly skip?: string // set when no sandbox can run the command: it must not run at all
  readonly unsandboxed?: boolean // the user confirmed this job may run without a sandbox (D23)
  wrap(command: string): Promise<string>
  readonly env: Record<string, string>
}

export interface GateDeps {
  readonly box: () => Promise<Wrapper>
  // The job's own grants (request_env / request_network): a gate that lost them would break `npm test` and
  // `uv run pytest`, which need their registries and caches.
  readonly grants: (project: string, jobId: string) => { domains: readonly string[]; env: readonly string[] }
  // D23: whether the user (or the config) confirmed this job may run without a sandbox. Without it a missing sandbox
  // skips the check, which is the fail-closed behaviour of A1.
  readonly unsandboxed?: (project: string, jobId: string) => boolean
}

export interface GateInput {
  readonly project: string
  readonly jobId: string
  readonly plan: boolean // a plan job: only the plan area is writable, never the project
  readonly writer: boolean
  readonly role: string
  readonly worktree: string // the git worktree root the command runs in
  readonly dir: string // the project directory inside it, where the command's paths resolve
  readonly frozen?: readonly string[]
}

// The gate of one run. Built per check run (the rules depend on the worktree and the grants), and cheap when the
// sandbox is off: nothing is wrapped and the caller skips — unless the user confirmed this job for exactly that, in
// which case the command runs as it is, with the cleaned environment and the job's grants, marked `unsandboxed`.
export async function gateFor(deps: GateDeps, input: GateInput): Promise<Gate> {
  const box = await deps.box()
  if (!box.available) {
    if (deps.unsandboxed?.(input.project, input.jobId) === true) {
      const grants = deps.grants(input.project, input.jobId)
      return { unsandboxed: true, wrap: async (c) => c, env: cleanEnv(process.env, grants.env) }
    }
    return { skip: `no sandbox on this machine${box.reason ? ` (${box.reason})` : ""}`, wrap: async (c) => c, env: {} }
  }
  const grants = deps.grants(input.project, input.jobId)
  const temp = tempDirFor(`${input.jobId}\0${input.worktree}`)
  const rules = input.plan
    ? planRules({ role: input.role, writer: true, dir: input.dir, worktree: planRoot(input.project), domains: grants.domains, frozen: input.frozen ?? [], temp })
    : rulesFor({ role: input.role, writer: input.writer, dir: input.dir, worktree: input.worktree, domains: grants.domains, frozen: input.frozen ?? [], temp })
  return {
    wrap: (command) => box.wrap(withTemp(command, temp), rules),
    env: cleanEnv(process.env, grants.env),
  }
}

// The words a stage line adds for a check that ran without a box (D23, A1-T14). The user's grant is named where the
// board is read, so an unwrapped run never looks like a sandboxed one.
export const UNSANDBOXED_NOTE = " (unsandboxed, confirmed by the user)"

export function unsandboxedNote(results: readonly { readonly unsandboxed?: boolean }[]): string {
  return results.some((r) => r.unsandboxed === true) ? UNSANDBOXED_NOTE : ""
}
