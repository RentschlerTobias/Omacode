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
`@omacode/guard` does not register the guard hooks twice. The TUI comes along:
OpenCode (2.2.5) loads a package's `./tui` export beside its server plugin, and
this package re-exports `@omacode/tui`'s. Run `npx -p @omacode/micromanager
omacode doctor` to see what is installed.
