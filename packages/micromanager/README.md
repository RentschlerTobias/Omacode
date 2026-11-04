# @omacode/micromanager

An OpenCode plugin that turns one chat into a job: it plans with you, splits the work into tasks, runs each task in
its own worktree with a role-scoped worker, reviews the result and merges what passes.

```bash
opencode plugin add @omacode/micromanager   # the orchestrator alone
opencode plugin add @omacode/full           # orchestrator + guard + sandbox + context
```

The orchestrator delegates; it never edits files or runs commands itself. Every worker runs under a role
(`explorer`, `coder`, `tester`, `designer`, `writer`, `debugger`, `reviewer`, `oracle`), asks the permission layer for
what it needs, and reports back against acceptance points. A watchdog catches loops, a checkpoint hands stuck tasks
back, and a merge train waits for the checks.

## What it needs

- OpenCode v2 and Node.js 22.12 or later.
- On Linux, the sandbox uses `bubblewrap`, `socat` and `ripgrep`; without them the plugin still runs, unwrapped.
- The decision model (Jev) is configured under `jev` in `micromanager.jsonc`; a local decision server can replace it
  for the local-first guards.

Configuration, the job flow, the roles and the design notes live in the repository:
<https://github.com/RentschlerTobias/Omacode#readme>.

## License

Apache-2.0. See `LICENSE` in the package.
