# Omacode packages

The plugin is split into independently installable packages. `micromanager` stays the name of the orchestrator.

| Package | What it does | Standalone |
|---|---|---|
| `@omacode/guard` | Redacts secrets, PII and names from outgoing HTTP requests and restores placeholders in responses and tool results. | yes |
| `@omacode/sandbox` | Wraps the shell commands of every delegated child in the sandbox; the user's own shell is never wrapped. | yes |
| `@omacode/context` | Context epochs, rules, token accounting, status files and project memory. | yes, rules-only without Jev |
| `@omacode/state` | Job/task schema, store, control files, roles, routing and picks. Library, no hooks. | library |
| `@omacode/tui` | Job progress, tasks, clickable workers and the context panel. | yes, tasks need job state |
| `@omacode/micromanager` | The orchestrator: roles, plans, delegation, tools, permissions, jobs and merge. | the product |
| `@omacode/full` | Orchestrator + guard + sandbox + context in one install. | composition |

## Install

```bash
opencode plugin add @omacode/full          # orchestrator + guard + sandbox + context
opencode plugin add @omacode/guard         # only redaction
opencode plugin add @omacode/sandbox       # only shell isolation
opencode plugin add @omacode/context       # only context + memory
opencode plugin add @omacode/micromanager  # the orchestrator
```

The TUI is a CLI plugin, not a server plugin: `opencode plugin add @omacode/tui` installs it and writes its
`./tui` entry into `~/.config/opencode/cli.json` (the package has no server part). `./install.sh --all` does the same
from a checkout.

## One setup per plugin

Each package claims its id in a process-wide registry. Installing `@omacode/full` and also `@omacode/guard` registers the guard hooks once.

## Development

```bash
npm install
npm run typecheck
npm run test:min       # package boundaries, ~0.3 s, 29 tests
npm test               # core behaviour, ~8 s, 317 tests
npm run test:all       # everything including browser, UI, evals, 535 tests
```

## Release

All packages share one version and are published in dependency order, so no package is on the registry before the
ones it depends on:

```bash
node scripts/release.mjs            # typecheck + test:min + `npm publish --dry-run` for all 8
node scripts/release.mjs --publish  # the real upload (2FA code per package, or NPM_TOKEN with bypass 2FA)
```

The version lives in the eight `package.json` files and in their exact cross-dependencies; bump them together. The
`LICENSE` at the repository root is copied into each tarball at `prepack` and removed again at `postpack`.

To try a release without touching npm, publish to a local registry first (e.g. `verdaccio`) and run
`opencode plugin add @omacode/full` against it.
