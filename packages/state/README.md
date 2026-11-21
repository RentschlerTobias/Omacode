# @omacode/state

The job schema and the files the TUI and the orchestrator share:

- `schema`: job, task, profile, design tree, policy and gate types, plus `RoleId`.
- `store`: `.opencode/omacode/jobs/*.json` (or an old state directory a project still has), notes and contract paths;
  rewrites a job's paths after the project folder moved and relinks its git worktrees.
- `control`: the per-job switches in `<state dir>/control/*.json`.
- `migrate`: moves an old state directory to `.opencode/omacode/`.
- `options`: the auto/parallel/review job options.

No plugin, no hooks. The orchestrator owns the transitions; the TUI reads the same files.
