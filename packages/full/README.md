# @omacode/full

One install for the standalone plugins:

- `@omacode/micromanager` (the orchestrator)
- `@omacode/guard`
- `@omacode/sandbox`
- `@omacode/context`

```bash
opencode plugin add @omacode/full
```

Each plugin still claims its own id, so installing `@omacode/full` and also
`@omacode/guard` does not register the guard hooks twice. The TUI is separate:
the host's `plugin add` only registers server plugins, so its `./tui` export
still goes into `cli.json`.
