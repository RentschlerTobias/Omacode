# @omacode/state

The job schema and the files the TUI and the orchestrator share:

- `schema`: job, task, profile, design tree, policy and gate types, plus `RoleId`.
- `store`: `.micromanager/jobs/*.json`, notes and contract paths.
- `control`: the per-job switches in `.micromanager/control/*.json`.
- `options`: the auto/parallel/review job options.

No plugin, no hooks. The orchestrator owns the transitions; the TUI reads the same files.
