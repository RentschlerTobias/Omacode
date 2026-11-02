// The shell plugin's wiring: a child session's shell command is wrapped in the sandbox, and the user's own shell is
// not. It works on its own (no micromanager installed): the session record's parent id is enough to tell a child
// from a root session. When the micromanager is there, it adds what it knows about its own workers: their role,
// their worktree, their frozen files and the job's grants.
//
// Two hooks are used, and the order matters: the tool hook (execute.before) knows the session and notes the
// command; the shell hook (create.before) has the command and wraps it. A command nobody announced is left alone,
// which is what keeps another agent's shell and the user's own out of the sandbox.
//
// The decision lives in decide.ts, so it can be tested without a host: a delegated child (a session with a parent)
// is wrapped, a root session (the user's own) never is.

import { cleanEnv, rulesFor, withTemp, type Rules, type Wrapper } from "./sandbox.ts"
import { isChildShell, type SessionFacts, type ShellCall } from "./decide.ts"
import type { RoleId } from "../roles.ts"

/** What the shell hook gets (opencode 2.0.18: "create.before" gets the shell to start). */
export interface ShellInput {
  command: string
  cwd?: string
  env?: Record<string, string | undefined>
}

/** The host's session record, as far as the shell plugin reads it. */
export interface SessionRecord {
  /** The session that started this one; a delegated child has one, a root session none. */
  parentID?: string
  /** The agent the session runs. */
  agent?: string
  location?: { directory?: string }
  directory?: string
}

/** What the plugin knows about the session a command comes from, beyond the session record. */
export interface SessionExtra {
  /** The session is a worker of this plugin. */
  readonly worker?: boolean
  /**
   * The plugin knows this session as one of its own, whatever the command's directory says. A plugin that knows a
   * session by its own bookkeeping says so here, so that its own rule for that session holds; a session the plugin
   * does not know at all is a child of some other plugin, and the generic rule (a delegated child is wrapped) holds.
   */
  readonly known?: boolean
  /** The role it works as (src/roles.ts). */
  readonly role?: RoleId
  /** Whether it writes; a reader writes nowhere. */
  readonly writer?: boolean
  /** Its own directory: the worktree of a writer, the project of a reader. */
  readonly dir?: string
  /** The worktree root it may write in. */
  readonly worktree?: string
  /** Files it may read and run but not change. */
  readonly frozen?: readonly string[]
  /** The job's granted hosts. */
  readonly domains?: readonly string[]
  /** The job's granted environment names. */
  readonly env?: readonly string[]
  /** The session's own temp directory, where its commands write their scratch files. */
  readonly temp?: string
  /** The project the session works in, when the plugin knows one. */
  readonly project?: string
  /** The job the session works for, when the plugin knows one. */
  readonly jobId?: string
}

/** The shells the plugin wraps. The host's shell tool is called "shell". */
export interface WorkerShells {
  expect(command: string, sessionID?: string): void
  take(command: string): boolean
  sessionOf(command: string): string | undefined
}

export interface ShellDeps {
  /** The sandbox the commands run in, or why there is none. */
  readonly sandbox: () => Promise<Wrapper>
  /** The session record of a session, or undefined when the host does not know it. */
  readonly session: (sessionID: string) => Promise<SessionRecord | undefined>
  /** What the plugin knows about a session, beyond its record. The cwd is the command's directory. */
  readonly extra?: (sessionID: string, cwd?: string) => SessionExtra | undefined
  /**
   * Whether a session is one of this plugin's workers, without a command in hand. The tool hook notes a worker's
   * command before the shell hook knows its directory, so the session itself is the only thing it can go by.
   */
  readonly isWorker?: (sessionID: string) => boolean
  /** The environment names every worker command keeps. */
  readonly env?: readonly string[]
  /** The hosts every worker command may reach. */
  readonly domains?: readonly string[]
  /** The command of a worker session is noted here, and the shell hook takes it from here. */
  readonly shells: WorkerShells
  /** A wrapped command -> the command the worker wrote. The permission layer judges the worker's own command. */
  readonly unwrapped?: Map<string, string>
  /** Where the worker's own temp directory is. */
  readonly temp?: (key: string) => string
  /** The rules of a command. The default is a writer's own worktree, a reader nowhere. */
  readonly rules?: (facts: SessionFacts & SessionExtra, input: ShellInput) => Rules
  /** Called after a command was wrapped, so the plugin can note the sandbox in its own state. */
  readonly onWrap?: (facts: SessionFacts & SessionExtra) => void | Promise<void>
  /** A line in the plugin's log. */
  readonly log?: (level: "info" | "warn" | "error", message: string) => void
}

/**
 * The rules of a command, when the plugin knows nothing more about the session: a writer writes its own
 * directory, a reader nowhere, and the network reaches the registries and whatever was granted.
 */
export function defaultRules(facts: SessionFacts & SessionExtra, input: ShellInput): Rules {
  const dir = facts.dir ?? input.cwd ?? process.cwd()
  return rulesFor({
    role: facts.role ?? "code",
    writer: facts.writer ?? true,
    dir,
    worktree: facts.worktree ?? dir,
    domains: facts.domains ?? [],
    frozen: facts.frozen ?? [],
    temp: facts.temp,
  })
}

/** The facts of a session: what its record says, plus what the plugin knows about it. */
export async function factsOf(deps: ShellDeps, sessionID: string, cwd?: string): Promise<SessionFacts & SessionExtra> {
  const record = await deps.session(sessionID).catch(() => undefined)
  const extra = deps.extra?.(sessionID, cwd) ?? {}
  return { parentID: record?.parentID, ...extra }
}
/** The shell plugin's hooks, so a plugin that already has a tool hook can call note() from it. */
export interface ShellHandle {
  /** Note a shell command of a child session, so the shell hook wraps it. */
  note(call: ShellCall): Promise<void>
}

/**
 * Install the shell plugin's wiring.
 *
 * The caller notes the commands of child sessions (handle.note); the shell hook wraps the commands it takes. A
 * command that no child session announced is left exactly as it is.
 *
 * The caller notes the commands itself, because a plugin that redacts a call before the shell sees it has to note
 * the redacted command, not the one the model wrote.
 */
export async function installShell(ctx: any, deps: ShellDeps): Promise<ShellHandle> {
  const rules = deps.rules ?? defaultRules

  const note = async (call: ShellCall): Promise<void> => {
    if (!call.sessionID) return
    // A session the plugin knows as its own worker needs no host lookup; any other session is looked up, because the
    // host's record says whether it was delegated (a child) or is the user's own (a root session).
    const worker = deps.isWorker?.(call.sessionID)
    const record = worker ? undefined : await deps.session(call.sessionID).catch(() => undefined)
    const facts: SessionFacts = { parentID: record?.parentID, worker }
    if (!isChildShell(call, facts)) return
    const command = String((call as { input?: Record<string, unknown> }).input?.command ?? "")
    if (command) deps.shells.expect(command, call.sessionID)
  }

  await ctx.shell?.hook("create.before", async (input: ShellInput) => {
    if (!deps.shells.take(input.command)) return
    const cwd = String(input.cwd ?? "")
    const sessionID = deps.shells.sessionOf(input.command)
    const facts = sessionID ? await factsOf(deps, sessionID, cwd) : {}
    // A session the plugin knows as its own is judged by the plugin's own rule: the facts it has about it (and the
    // command's directory) decide. A session it does not know at all is a child of some other plugin: the generic
    // rule holds, a delegated child is wrapped. The user's own shell is a root session, and no rule wraps it.
    if (facts.known) {
      if (!facts.worker && !facts.dir) return
    } else if (!facts.parentID) {
      return
    }
    input.env = cleanEnv(input.env ?? process.env, [...(deps.env ?? []), ...(facts.env ?? [])])
    const box = await deps.sandbox()
    if (!box.available) return
    const temp = facts.temp ?? deps.temp?.(cwd)
    const own = { ...facts, temp }
    const wrapped = await box.wrap(withTemp(input.command, temp), rules(own, input))
    const seen = deps.unwrapped
    if (seen) {
      seen.set(wrapped, input.command)
      if (seen.size > 500) seen.delete(seen.keys().next().value!)
    }
    input.command = wrapped
    await deps.onWrap?.(own)
  })

  return { note }
}
