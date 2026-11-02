// The shell plugin: a child session's shell command runs in the sandbox, and the user's own shell does not.
//
// It works on its own, with no micromanager installed: the host's session record says whether a session was
// delegated, and that is enough. The micromanager, when it is there, adds what it knows about its own workers
// (their role, their worktree, their frozen files, their job's grants) through the deps.
//
//   import shell from "micromanager/shell"
//   export default shell

import { installShell, type ShellDeps } from "./wire.ts"
import { startSandbox, WorkerShells, type Wrapper } from "./sandbox.ts"

export interface ShellPluginDeps extends Partial<ShellDeps> {
  /** The shells of the server, shared between the instances of one host. */
  readonly shells?: WorkerShells
  /** The sandbox of the server, shared between the instances of one host. */
  readonly sandbox?: () => Promise<Wrapper>
}

/**
 * The sandbox and the shells of one server, shared between its instances: the tool hook of one instance notes a
 * child's command, and the shell hook of another takes it.
 */
const SHARED: { shells?: WorkerShells; sandbox?: Promise<Wrapper> } =
  ((globalThis as { __micromanagerShell?: { shells?: WorkerShells; sandbox?: Promise<Wrapper> } }).__micromanagerShell ??= {})

export const defaultShellDeps = (deps: ShellPluginDeps = {}): ShellDeps => {
  const shells = deps.shells ?? (SHARED.shells ??= new WorkerShells())
  const sandbox = deps.sandbox ?? (() => (SHARED.sandbox ??= startSandbox(true)))
  return {
    sandbox,
    session: deps.session ?? (async () => undefined),
    extra: deps.extra,
    env: deps.env,
    domains: deps.domains,
    shells: deps.shells
      ? { expect: (c, s) => deps.shells!.expect(c, s), take: (c) => deps.shells!.take(c), sessionOf: (c) => deps.shells!.sessionOf(c) }
      : { expect: (c, s) => shells.expect(c, s), take: (c) => shells.take(c), sessionOf: (c) => shells.sessionOf(c) },
    unwrapped: deps.unwrapped,
    temp: deps.temp,
    rules: deps.rules,
    log: deps.log,
  }
}

export default {
  id: "micromanager-shell",
  setup: async (ctx: unknown, deps: ShellPluginDeps = {}): Promise<void> => {
    const anyCtx = ctx as { tool?: { hook(name: string, cb: (call: any) => Promise<void> | void): Promise<unknown> }; session?: { get?(args: { sessionID: string }): Promise<unknown> } }
    const shell = await installShell(anyCtx, defaultShellDeps(deps))
    // The tool hook of the plugin on its own: it notes the commands of the child sessions. A plugin that redacts a
    // call before the shell sees it notes the redacted command itself, through the handle.
    await anyCtx.tool?.hook("execute.before", async (call: any) => {
      await shell.note(call)
    })
  },
}

export { installShell } from "./wire.ts"
export { isChildShell, isDelegated, SHELL_TOOL, type SessionFacts, type ShellCall } from "./decide.ts"
export { cleanEnv, looksSecret, neverHanded, REGISTRIES, rulesFor, startSandbox, tempDirFor, withTemp, WorkerShells, type Rules, type Wrapper } from "./sandbox.ts"
