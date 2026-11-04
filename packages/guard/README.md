# @omacode/guard

Redacts private data before it leaves the machine, and restores placeholders in what comes back.

The guard is a standalone OpenCode plugin. It needs neither `micromanager` nor any other Omacode plugin.

```bash
opencode plugin add @omacode/guard
```

It reads `~/.config/opencode/guard.jsonc` (or `.opencode/guard.jsonc` in a project). If neither exists, it falls back to
the `redact` block of `micromanager.jsonc`, so an existing setup keeps working. Secrets and structured PII are on by
default; the optional name/address detector is off.

```jsonc
{
  "secrets": true,
  "pii": true,
  "names": false,
  "nameAddress": true,
  "threshold": 0.5,
  "allow": ["a value that must never be redacted"]
}
```

What it hooks:

- `http.request`: the serialized model request is redacted before it is sent.
- `http.response`: placeholders are restored in the answer.
- `context`, `compaction`, `generate`, `title`: the session-shaped fallback, including the placeholder note.
- tool `execute.before` / `execute.after`: placeholders are restored where a tool may see them, and results are
  redacted on the way back.

The placeholder vault lives in the OpenCode state directory and is stable across restarts. The same local value always
gets the same placeholder, so a model can reason about it without seeing it.
