# @omacode/context

Context management for OpenCode sessions. It owns the single `session.context` hook and keeps memory as an internal
module, so no second plugin has to inject context or recall.

## Install

```bash
opencode plugin add @omacode/context
```

## What it does

- Counts tokens from the ledger and the host's usage tap.
- Compacts tool results with the rules, and records an epoch when the context passes its ceiling.
- Writes the per-session status file the TUI reads.
- Injects core project memory, and recall for the current prompt when memory is enabled.
- Runs rule-only without Jev; a summarizer, judge, job/task state and the memory store are optional.

## Configuration

`~/.config/opencode/omacode/context.jsonc` (or `.opencode/...` in a project):

```jsonc
{
  "ceilingTokens": 100000,
  "keepTurns": 8,
  "memory": true
}
```

## Memory

Memory is a module of this package, not a second plugin. It owns the SQLite store, embeddings and the memory tools.
The context plugin is the only owner of `session.context`; the memory module exposes the service it uses.
