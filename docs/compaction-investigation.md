# Why auto-compaction never fired on a ~500k-token orchestrator session

Scope: read-only investigation of commit 29d5926 (worktree checkout). No source changed. Repro scripts live outside
the repo (`/tmp/micromanager-1000/71da499eea528a84/tmp.BskSETROxk/repro.ts`, `repro2.ts`) and are not committed.

## Verification against 29d5926 (T8)

Status: root cause holds. Re-read against the current code (this worktree, HEAD 29d5926). Line references below were
checked by reading the source; the text repro was not re-run.

- Confirmed: `src/plugin.ts:2812` ceiling; `2948` orchestrator goes through `manageContext(input, true)`; `2994` hook
  is `"context"` only.
- Confirmed: `src/context/manager.ts:134` `if (s.pending.size)` gates the verdict; `policy.ts:54` `minSavedTokens`
  precedes the ceiling test at `policy.ts:55`.
- Confirmed: `ledger.ts:74` tool results only; `rules.ts:36-38` reads, shells, web, writes, errored calls only;
  `compact.ts:70` candidates are tool results only.
- Added: `compact.ts:148` judge asks only when `load >= startChars`. Below that, nothing is kept or pruned by the judge.
- Added: `src/` has no `model.request` or `http.request` hook (`grep -rn 'model.request\|http.request' src` is empty).
  Only `http.response` is registered (`plugin.ts:3002`). A provider-usage count would need one of them; not done here.
- Not confirmed: the user's journal. `~/.local/state/micromanager/` exists and is empty; no `decisions.jsonl`. Causes 2
  and 3 stay unproven.

## Root cause

Root cause: compaction only reduces tool results. The ceiling only gates an epoch that already has pending tool-result
replacements. A session whose bulk is text (user messages, assistant text, worker reports delivered as user messages)
has nothing that can be reduced, so the ceiling never leads to any action, at any size.

Evidence (repro, real modules, `ContextManager({ dir: null })`, ceiling 100 000, 220 turns of 4 000 characters):

| Bulk kind | Estimated tokens (chars / 3.5) | Epoch | Pending | Summary started |
|---|---|---|---|---|
| text only (user and assistant text parts) | 503 430 | none | 0 | false |
| subagent tool results, no decider (Compactor fallback) | 253 102 (after judge: 10 870) | ceiling | 0 | true |

The text row reproduces the observation: 503k estimated tokens, no epoch, no summary, no candidate.

## Trigger path (file:line)

1. Hook registration: `ctx.session.hook("context", ...)` at `src/plugin.ts:2994`. Calls `shapeContext` (2854),
   then `redactRequest` (2997).
2. Orchestrator branch: `input.agent === MICROMANAGER.agent` skips the early `return` at 2861-2862 and reaches
   `await manageContext(input, true)` at `src/plugin.ts:2948`. The orchestrator is hooked. Workers take
   `manageContext(input, false)` at 2862 with a 120k ceiling.
3. Ceiling: `const ceilingTokens = orchestrator ? 100_000 : 120_000` at `src/plugin.ts:2812`.
4. Stage 1 (Jev judge): `compactor.judge(...)` at `src/plugin.ts:2813`, class at `src/compact.ts:113-161`.
5. Stage 3 (summary start): `summarizer.maybeStart(...)` at `src/plugin.ts:2817`; `src/context/summary.ts:138-160`.
6. Apply: `contextManager.apply(..., { ceilingTokens, judged })` at `src/plugin.ts:2823`; `src/context/manager.ts:125-160`.
7. Token count: `contextLedger(input.messages)` at `src/plugin.ts:2815`, then `(l.chars + system chars - savedChars) / 3.5`
   (`src/plugin.ts:2817`, `src/context/policy.ts:23` `charsPerToken: 3.5`). No provider usage is read.
8. Epoch gate: `if (s.pending.size)` at `src/context/manager.ts:134`. Nothing is evaluated when pending is empty.
9. Verdict: `epochDue` at `src/context/policy.ts:50-58`. `minSavedTokens` (54) comes before the ceiling test (55).
   The ceiling only returns `due: true` when `savedTokens >= minSavedTokens`.
10. Pending sources: `#collect` (`manager.ts:162-175`) takes `findReplacements` (rules) and `judged` only.
11. Status for the sidebar: `writeStatus` at `src/plugin.ts:2834`, from the same estimate.

## Ranked causes

### 1. Ceiling gates epochs, not reductions; text bulk has no reduction path (most likely; confirmed by repro)

- Ledger items are tool results only: `src/context/ledger.ts:74` (`if (m.role !== "tool") return`). User and assistant
  text is counted in `chars` (`ledger.ts:46-47`) but never becomes an item.
- Rules touch only reads, shells, web, writes, errored calls: `src/context/rules.ts:36-38`. Subagent reports, todo,
  question and skill results are excluded by design (`rules.ts:36-37` comment).
- Judge candidates are tool results only: `src/compact.ts:70` (`if (m.role === "tool")`).
- Summary segments: `segmentOf` in `src/context/summary.ts:40-45` returns undefined when `items` is empty or
  `chars < minChars` (20 000). Text is included in the transcript (`summary.ts:50-62`) but not replaced.
- Result: a text-heavy session reaches 100k, the ceiling is true, `pending` stays empty, and `apply` never reaches the
  verdict. Text-only repro: epoch none, pending 0, summary not started.

### 2. Jev judge keeps everything; the ceiling does not override a "needed" answer (plausible; unproven in the live run)

- `src/compact.ts:148-157`: `needed = a.noul >= NOUL_FLOOR` (0.5, `src/catalog.ts:67`). A kept result is never pruned
  while the context is large. `judge` has no size argument.
- Kept results are re-asked every `reaskAge` (6) turns (`compact.ts:145`), so the answer can stay "needed" for the
  whole session.
- Only the missing-answer path falls back to age (`compact.ts:155`, `c.age < ruleAge`), and only when `decider` is
  undefined or the ask fails (`compact.ts:150-151`, `.catch(() => undefined)`).
- The journal shows this as `kind: "compaction"` with `asked > 0` and `pruned` near 0 (`compact.ts:131`). Check that
  line in the user's journal before accepting this cause.

### 3. Estimate skew: chars / 3.5, no provider usage, images count 0 (possible; unproven)

- The estimate ignores provider usage, so a 5x undercount needs ~100k estimated tokens at ~500k real tokens. The text
  path shows the estimate is accurate for text (503k estimated for 1.76M characters), so the skew must come from
  content the ledger does not count.
- `textOf` (`ledger.ts:46-47`) counts `text`, `input` and `result` only. An image or attachment part counts 0.
- Tool definitions are not counted: only `input.system` (`plugin.ts:2817`, `2822`) is in `baseChars`.
- The hook's message list may not hold the whole history in OpenCode 2.0.18. Not checked here; the hook is the only
  source the plugin has.

### 4. Failures are swallowed (contributing; does not cause the no-op, hides it)

- `src/plugin.ts:2835-2837`: any exception in `manageContext` becomes `log("warn", ...)` only. No journal entry, no
  sidebar mark.
- `src/context/summary.ts:150-151`: `generate` errors become `""`; the journal row has `ok: false` (`summary.ts:153`).
  `plugin.ts:2800-2803` (session create, prompt, wait) can throw there, and the error is lost.
- `src/context/summary.ts:150`: a 120 s timeout resolves `""` the same way, so a stalled summarizer looks like a
  failed one every turn.
- No journal row says "ceiling reached, nothing to reduce". The ceiling state is visible only in the sidebar estimate
  (`plugin.ts:2834`).

### 5. OpenCode's own compaction is not this hook (noted, not tested)

- `src/context/manager.ts:164` says OpenCode compacts sessions itself. The `compaction` request kind (listed in
  `docs/plan.md:201`) is not hooked by `plugin.ts:2994`. If the user saw a host compaction message, it would not be
  this plugin's. Not verified.

## Fix direction (minimal steps)

1. Make the ceiling a reduction trigger, not only an epoch gate. When `contextTokens >= ceilingTokens` and `pending` is
   empty, compaction must still act. Options, in order of fit: (a) include the oldest user and assistant text parts
   as summary segment input, with a replacement that keeps every tool call and every user request intact; (b) start
   the summary with no `minChars` floor at the ceiling.
2. Let the ceiling override a Jev "needed" answer above a size threshold (e.g. prune the oldest kept results first),
   so the judge cannot hold a session at 500k.
3. Count with the provider's usage when present (the last assistant message's input tokens), and count image and
   attachment parts in `textOf`. Keep chars / 3.5 as the fallback only.
4. Make the no-op visible: journal `context.stalled` (reason, tokens, pending, bulk kinds) when the ceiling holds for N
   requests with no epoch; journal the summary error text instead of `ok: false` alone; log the `manageContext`
   exception to the journal too.
5. Extract the decision from the plugin closure (`manageContext`, `plugin.ts:2808-2847`) into a pure function, so a
   test can drive it without OpenCode.

## How T9 should test that compaction fires

- Unit (no OpenCode): a text-only session of ~1.76M characters with ceiling 100 000. Assert an epoch with
  `reason: "ceiling"` (or a new reduction) and that tool calls keep their results. Today this fails: epoch none,
  pending 0. Use `new ContextManager({ dir: null })` and the `Summarizer` with a stub `generate`.
- Unit: a subagent-result session where the judge answers "needed" for all candidates above the ceiling. Assert the
  ceiling still reduces something. Today this fails (no fallback above the ceiling).
- Unit: image parts counted. A message with an image part of 400 000 characters adds to the estimate.
- Unit: `generate` throws. Assert a journal row with the error text, not only `ok: false`.
- Regression guard: the existing subagent-result scenario (judge fallback, `reason: "ceiling"`, pending 0 after the
  epoch) must keep passing. Run `npm test` and `tsc -p tsconfig.json`.
