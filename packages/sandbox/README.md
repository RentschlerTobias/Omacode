# @omacode/sandbox

Runs the shell commands of delegated child sessions in a sandbox, and leaves the user's own shell alone.

The sandbox is a standalone OpenCode plugin. It needs neither `micromanager` nor any other Omacode plugin.

```bash
opencode plugin add @omacode/sandbox
```

A child session is a session the host reports with a `parentID`; the plugin looks it up through `ctx.session.get`.
The decision is in `decide.ts`: a child's shell is wrapped, a root session's shell is not. The user's own commands are
never sandboxed.

When `micromanager` is installed too, it registers its workers with the sandbox service. That adds the facts the host
may not report: the worker's role, worktree, frozen files and grants. Without it the generic rule applies.

Filesystem and network rules come from `sandbox.ts`; the default is the package registries plus the project directory.
The sandbox is one per server, shared through a `globalThis` slot, so a tool hook from one plugin instance can note a
command that a shell hook from another instance wraps.
