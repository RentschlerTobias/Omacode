# @omacode/tui

The OpenCode TUI plugin. It reads the job/control files through `@omacode/state` and the context status files through `@omacode/context`, so it does not import the orchestrator.

- job progress line and sidebar checklist
- `/tasks`: open a task's worker session
- `/workers`: recent sessions and their workers, click through
- `/pools`: models per role
- CONTEXT panel: tokens, epochs, memory

Without an orchestrator or context plugin there are no jobs and no status files; the task panels stay empty, while the session and model panels still work.

Install the package, then add its `./tui` export to `~/.config/opencode/cli.json` (the host's `plugin add` only registers server plugins).
