// Which shell commands belong to a child session and are therefore wrapped in the sandbox.
//
// The shell hook of OpenCode gets no session id (opencode 2.0.18: "create.before" gets { command, cwd, timeout,
// shell, env } only), so the shell plugin cannot ask "whose command is this?" there. It can only ask "was this
// command announced by a child session?" — the tool hook (execute.before) does know the session and notes the
// command before the shell is created. This module holds that decision, so it can be tested without a host.
//
// The invariant the decision exists for: a child shell of any plugin runs in the sandbox, and the user's own
// interactive shell never does. A root session (no parent) is the user's own; a delegated child (a parent) is not.

/** A tool call, as the tool hook sees it. */
export interface ShellCall {
  readonly tool: string
  readonly sessionID?: string
  readonly agent?: string
}

/** What is known about the session a call comes from. */
export interface SessionFacts {
  /** The session that started this one. A delegated child has one; a root session (the user's own) has none. */
  readonly parentID?: string
  /** The session is a worker of the plugin that started it, whatever the session record says. */
  readonly worker?: boolean
}

/** The shells the plugin wraps. OpenCode's shell tool is called "shell". */
export const SHELL_TOOL = "shell"

/**
 * Whether this call is a shell command of a child session: one the sandbox wraps.
 *
 * A call counts when it is the shell tool and its session is a delegated child (it has a parent) or a known
 * worker. A root session with no parent is the user's own interactive session, and its shell is left alone.
 */
export function isChildShell(call: ShellCall, facts: SessionFacts | undefined): boolean {
  if (call.tool !== SHELL_TOOL) return false
  if (!call.sessionID) return false
  if (facts?.worker) return true
  return Boolean(facts?.parentID)
}

/**
 * Whether the session record says this session was delegated: a child session has a parent.
 *
 * The host drops the parent id for some sessions, so this is one signal among others and never the only one: a
 * session the plugin knows as a worker is a worker even without a parent id.
 */
export function isDelegated(facts: SessionFacts | undefined): boolean {
  return Boolean(facts?.parentID) || Boolean(facts?.worker)
}
