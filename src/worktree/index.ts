// The worktree plugin: a job's branch and worktree, a task's own worktree, and the merge train that puts a task's
// commits back on the job's branch.
//
// It works on its own, with no micromanager installed: everything here is git and a path. The micromanager, when it
// is there, calls into it for the tasks it starts.
//
//   import worktree from "micromanager/worktree"
//   export default worktree

import * as git from "./git.ts"

export interface WorktreePluginDeps {
  /** The git commands. The default is git itself; a test injects its own. */
  readonly run?: git.Exec
}

/** The worktree handling, as the plugin publishes it to the host and to the other plugins. */
export interface WorktreeApi {
  readonly exec: git.Exec
  readonly jobBranch: typeof git.jobBranch
  readonly taskBranch: typeof git.taskBranch
  readonly taskDir: typeof git.taskDir
  readonly prepareIntegration: typeof git.prepareIntegration
  readonly prepareTaskWorktree: typeof git.prepareTaskWorktree
  readonly removeTaskWorktree: typeof git.removeTaskWorktree
  readonly rebaseTask: typeof git.rebaseTask
  readonly fastForward: typeof git.fastForward
  readonly frozenChanged: typeof git.frozenChanged
  readonly frozenCheck: typeof git.frozenCheck
  readonly commitTask: typeof git.commitTask
  readonly changedFiles: typeof git.changedFiles
  readonly workingDiff: typeof git.workingDiff
  readonly revertFiles: typeof git.revertFiles
  readonly validateIntegration: typeof git.validateIntegration
  readonly runGate: typeof git.runGate
}

/**
 * The worktree plugin's own wiring: it has no hook to install, because the worktree handling is called, not
 * hooked. It publishes the handling instead, so that a host (or another plugin) finds it without knowing the
 * micromanager. The micromanager, when it is there, calls into the same module.
 */
const SHARED: { api?: WorktreeApi } =
  ((globalThis as { __micromanagerWorktree?: { api?: WorktreeApi } }).__micromanagerWorktree ??= {})

/** The worktree handling as it was published; undefined while no worktree plugin is installed. */
export const worktreeApi = (): WorktreeApi | undefined => SHARED.api

export const defaultWorktreeDeps = (deps: WorktreePluginDeps = {}): WorktreeApi => ({
  exec: deps.run ?? git.exec,
  jobBranch: git.jobBranch,
  taskBranch: git.taskBranch,
  taskDir: git.taskDir,
  prepareIntegration: git.prepareIntegration,
  prepareTaskWorktree: git.prepareTaskWorktree,
  removeTaskWorktree: git.removeTaskWorktree,
  rebaseTask: git.rebaseTask,
  fastForward: git.fastForward,
  frozenChanged: git.frozenChanged,
  frozenCheck: git.frozenCheck,
  commitTask: git.commitTask,
  changedFiles: git.changedFiles,
  workingDiff: git.workingDiff,
  revertFiles: git.revertFiles,
  validateIntegration: git.validateIntegration,
  runGate: git.runGate,
})

export default {
  id: "micromanager-worktree",
  setup: async (_ctx: unknown, deps: WorktreePluginDeps = {}): Promise<void> => {
    SHARED.api = defaultWorktreeDeps(deps)
  },
}

export {
  BRANCH_PREFIX,
  changedFiles,
  commitTask,
  dirtyDeclared,
  dirtyPaths,
  exec,
  fastForward,
  frozenChanged,
  frozenCheck,
  gradedOf,
  hashFiles,
  IntegrationError,
  jobBranch,
  LEGACY_BRANCH_PREFIX,
  prepareIntegration,
  prepareTaskWorktree,
  projectRel,
  rebaseTask,
  removeTaskWorktree,
  repoRel,
  revertFiles,
  runEvaluator,
  runGate,
  taskBranch,
  taskDir,
  validateIntegration,
  workingDiff,
  type Cancelled,
  type Exec,
  type GateResult,
  type Integration,
  type Run,
  type TaskWorktree,
  type TrainStep,
} from "./git.ts"
