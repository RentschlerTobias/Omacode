# Omacode Roadmap — Detailed Execution Plan

Status: **v4 — revised after review rounds 1–3**
Date: 2026-11-15
Repo: `/home/t1dde/Fun/Projects/Repos/micromanager`
Product: **Omacode** (the harness); **Micromanager** is the orchestrator package.
Scope: 0.2 control & safety, 0.3+0.4 artifact pipeline (video/motion, deck, web, images), then UI.
Out of scope now: external code review, MCP manager, Remotion, any model whose license excludes the EU.

> **How to read v4.** §2.2 maps the 14 round-1 findings to the task that fixes each; §2.6 does the same for round 2;
> §2.8 for round 3. §2.3 and §2.5 record the decisions taken and not taken.
> **The two structural changes are a two-track execution order** (safety and artifacts run in parallel, D22) **and a
> rule that no harness execution path may run worker-authored text outside the sandbox.**

---

## 1. Context and decisions

These decisions are binding for this plan. D1–D18 come from the working session; D19–D22 were taken after review.

| # | Decision |
|---|---|
| D1 | Project/product is **Omacode**; `micromanager` remains the orchestrator package and agent id. |
| D2 | The plugin is **not commercial**. Licenses are still respected. |
| D3 | No models whose open-weight license excludes the EU/UK/South Korea. **MiniMax H3 and HunyuanVideo are out.** |
| D4 | Video generation uses **Wan 2.2** (Apache-2.0) primarily; Mochi 1 and CogVideoX are alternatives. Owned by **B2b**. |
| D5 | **HyperFrames is the primary video/motion/slideshow engine**; Manim for math; Blender for 3D assets. |
| D6 | **HTML presentations are primary**; PPTX is an optional handoff export. |
| D7 | Remotion is rejected (license). |
| D8 | Code review and the MCP server manager are **skipped** for now. |
| D9 | The UI redesign is deferred; **Rulebook is the first UI item**. No localhost web UI; use a TUI panel. |
| D10 | Plan mode is a **hard boundary**, not a prompt: plan worktrees, plan-only tool set, write guard, sandbox. **It fails closed**, and **every execution path — including task checks and the host runner — is inside the boundary**. The one exception is D23: a job the user explicitly confirmed may run unsandboxed, recorded with its risk score. |
| D11 | The decider has exactly **two modes: `local` and `cloud`**. There is no hybrid. A missing backend is a *state*, not a mode. |
| D12 | `refusal_likely` is removed. Guards are `injection`, `harmful`, `sensitive`. The rulebook version is bumped and re-benchmarked in the same job. |
| D13 | Cloud sends only after deterministic redaction, **enforced inside the client** so no call site can bypass it. With no local NER every cloud call is previewed and confirmed. |
| D14 | autoMerge is ported from the **tag `archive/automerge`**, extended with a policy, a backup ref, persisted state, and merge asks that route to the **user**, never to the orchestrator. |
| D15 | Memory is available to every agent; writes still go through validation. |
| D16 | Project state moves to **`.opencode/omacode/`**, with a backward-compatible migration and **no in-project symlink**. |
| D17 | A setup assistant detects resources, asks only what detection cannot answer, installs only chosen components, and can undo itself. |
| D18 | Every third-party component is recorded with license, territory and usage, and the restrictions are **enforced at runtime** — a checkpoint whose hash is unknown is refused, not allowed. |
| D19 | The cloud decider client is **kept** (renamed, constructible only in `cloud` mode). It is also the **label factory** the local model is trained from. |
| D20 | **Contracts before adapters.** Spec, checks, provenance and adapter interface land first; `artifactd` (daemon, queue, GPU lock) is deferred until a GPU render needs it. **The deck is the first vertical slice.** |
| D21 | `local` is the **mode from day one** — nothing leaves the machine. What the bench gates is **per-node floors**: until a node passes, its floors stay conservative and low confidence asks the user; once it passes, its calibrated floors apply and the ask-rate drops. Never a silent cloud call. |
| D22 | **Two tracks.** Safety (A) and artifacts (B) do not wait for each other, except where a schema is genuinely shared. The first artifact job starts after A1, not after A6. |
| D23 | **Unsandboxed is a user decision, never a default.** When no sandbox can run, a job's commands and checks run unwrapped **only after the user confirmed it for that job** in a form, with a deterministic risk score shown first. The grant is journaled with the score; `never` keeps the fail-closed path, `allow` stores the grant without asking (also journaled). Without an answer nothing runs. |
| D24 | **B3 ships the HTML deck only; PPTX is deferred.** On the user's direction (2026-11-15) B3-T3 and B3-T5 leave B3 and move to a later job: no `pptxgenjs`, no PPTX checks, no LibreOffice path in B3. The deck is presented and checked as HTML; a PPTX handoff is not part of the first vertical slice. |

### Assumptions

- Primary platform Linux; macOS supported; Windows later.
- OpenCode v2 TUI; no embedded webview, no floating OS window.
- The user is in Germany/EU; territory checks default to EU.
- A 48 GB GPU and several 24 GB RTX 3090s **may be on another host** — topology is decided in B6-T1, not assumed.
- Sandbox availability is a **precondition** for plan mode (D10), not an assumption.
- Local decider runs on CPU; image/video models run on GPU.
- No network access is required for normal coding work.

---

## 2. Review rounds 1–3 → what changed

### 2.1 Verdicts

| Reviewer | Focus | Round 1 | Round 2 | Round 3 |
|---|---|---|---|---|
| **Luna** (GPT-6) | delivery / job split | not ready | not ready | not ready → fixed in v4 (§2.8) |
| **GLM-5.3-Flash** | product / licensing / UX | ready after fixes | ready after fixes | — |
| **Qwen3.8 Flash** | architecture / security | ready after fixes | ready after fixes | **ready to execute** |
| **Hy4** | red team / assumptions | not ready | ready after fixes | — |

Round 2 found no structural fault, only unowned edges. Round 3 (Luna and Qwen only) found no security gap: Qwen verified
that both host `sh -c` paths, the host runner and the fail-closed rule are closed, and returned **ready to execute**.
Luna found one real contradiction and two gaps, all fixed in v4.

### 2.2 Round-1 blocking findings and where they are fixed

Line numbers are the reviewers' readings of `a0f7d65`. Re-verify at implementation time.

| # | Finding | Found by | Fixed in |
|---|---|---|---|
| 1 | Wan 2.2 has **no owning task** | Luna, GLM | **B2b** |
| 2 | A2 removes the **decision engine**, not a backend | GLM, Qwen, Hy4 | **A2** (T1–T9) |
| 3 | `rules` answers nothing, so `local` + no model = every decision asks the user | GLM, Hy4 | **A2b** + **D21** |
| 4 | Plan worktree path not recognised by `decide.ts` | Qwen | **A1-T10** |
| 5 | Sandbox **fails open** (`sandbox.ts:164-187`) | Qwen, Hy4 | **A1-T7**, **A1-T11** |
| 6 | No **symlink/`realpath`** hardening | Qwen | **A1-T3a**, **A1-T6** |
| 7 | Auto-mode merge asks answered by the orchestrator | Qwen | **A3-T3** |
| 8 | `mergeIntoCheckout` absent at HEAD; `archive/automerge` is a tag | GLM, Hy4 | **A3-T1**, **A3-T2** |
| 9 | A5 blast radius ~12 files; symlink is a bypass | Hy4, Luna | **A5-T5**, D16 |
| 10 | A1-T4 denies `auto_merge`, which does not exist | GLM | **A1-T4** |
| 11 | `artifactd` assumes a **local** GPU | Hy4 | **B6-T1** |
| 12 | A6 installs `artifactd` before it exists | Luna | **A6-T6** |
| 13 | TUI ships compiled `tui.js`; C1 depends on A2 | Hy4, Luna, GLM | **C1-T7**, job map |
| 14 | "Cloud override" / "redaction uncertain" undefined | Qwen | **A2-T5**, **A2-T6** |

### 2.3 Decisions taken after round 1

| Question | Decision |
|---|---|
| B1: generic core or vertical slice first? | Contracts first, then the deck slice (D20); `artifactd` becomes **B6**. |
| D16: keep the rename? | **Keep `.opencode/omacode`.** `micromanager` is a package, `omacode` is the product. |
| Decider default: `local` or `hybrid`? | **No hybrid.** Two modes; shell permissions join the local model once A2b supplies data and floors. |
| Jev: delete or keep? | **Keep, demoted** (D19): one client, `cloud` mode only, also the label factory. |

### 2.4 Round-1 non-blocking findings also taken

- Blacklist gains `git stash|branch|worktree|config|gc|update-ref` (A1-T6).
- autoMerge state is **persisted** (A3-T4); backup refs pruned on `discard_job` (A3-T5).
- `artifactd` validates inputs and authenticates its socket (B6-T6).
- ComfyUI checkpoints are checked by **file hash** (B5-T4).
- The license manifest carries a **commercial-use-of-output** column (A6-T9).
- `omacode uninstall` exists (A6-T11).
- HyperFrames' own `doctor` is called instead of re-implemented (A6-T6).
- LibreOffice is an explicit opt-out with the consequence stated (B3-T3).
- `README.md` and `docs/design.md` carry the rename (A2-T8).
- Plan → artifact handoff and an output-quality gate are tasks (B1-T6, B1-T7).

### 2.5 Findings deliberately not taken

| Finding | Why not |
|---|---|
| Split A1 into three jobs (Luna) | A1 stays one job with a stated internal order (§5 A1). Splitting multiplies the shared-file merge risk. |
| Merge A1–A5 into one job (Hy4) | Too large to review or bisect. |
| Remove `openjev` from the backend list (GLM, Hy4) | It is local and costs a fallback-chain member; it is disabled by default when no server is installed (A2-T1). |

**Taken in v3 after round 2:** Hy4's round-1 call *"cut B1's A1–A6 dependency"* was **not listed here in v2** — that was
a bookkeeping error, and the call is now taken (B1 depends on A1-T8 only, see §4).

### 2.6 Round-2 findings and where they are fixed

| # | Finding | Found by | Fixed in |
|---|---|---|---|
| 1 | **Host runner** executes arbitrary commands outside the sandbox (B1-T5) | Luna, Qwen | **B1-T5** (allowlist, argv-only, `cleanEnv`); **B6-T6** extends it |
| 2 | **Plan-mode checks** run on the plugin host via `sh -c` (`worktree/git.ts:277-291`) | Qwen | **A1-T12** |
| 3 | D21 gate had **no thresholds**, and `npm run bench` does not exist | Luna, Hy4, GLM | **A2b-T4/T5/T6** |
| 4 | **B1 depended on A1–A6**; the first usable output was the 9th job | Hy4 | **D22**, §4 job map |
| 5 | A5 inventory still short; "no literal remains" unsatisfiable; T0 too late | Luna, GLM, Hy4 | **A5-T5/T6**, **A1-T13**, **A5-T0** |
| 6 | Redaction had **no enforcement locus** (four call sites bypass `Decider.ask`) | GLM | **A2-T6**, **A2-T9** |
| 7 | A1-T7 and A1-T11 contradicted each other on fail-closed | Qwen | **A1-T7**, **A1-T11** |
| 8 | "No cloud asker in `local` mode" was false; the local client is a `Jev` | Hy4 | **A2-T9** reworded |
| 9 | Build mode could not **read** `plan.md` (`roles.ts` `noStateDir`) | GLM | **A1-T4** |
| 10 | Unknown checkpoint hash **sailed through** the territory block | GLM | **B5-T4** |
| 11 | A2b-T1 was ordered after A2, but A2-T9 needed it | Hy4, Qwen | **A2-T2b** |
| 12 | B2 was too large for one job | Luna | **B2 / B2b / B2c** |
| 13 | B3-T6 pulled in adapters that land later | Hy4 | **B3-T6** (placeholders only) |
| 14 | No-git plan worktree had no copy exclusions | Luna | **A1-T1** |
| 15 | Git hooks in the user's checkout had no owning task | Qwen | **A3-T3**, **A3-T6** |
| 16 | Nothing bridged "installed" to "first successful deck" | GLM | **C2-T7** |
| 17 | "Unredactable" was undefined | Qwen | **A2-T5** |
| 18 | §3's third "mode" contradicted D11 | Hy4 | §3 reworded |
| 19 | `tui.js` drift test covered only C1/C2 | GLM | **C1-T7** extended |
| 20 | Local decider (A6-T5) covers only the 4 guards, so it does not fix the ask storm | Hy4 | **A2b-T2** (non-guard nodes), **A6-T5** reworded |

### 2.7 Claims verified while writing v3

Checked against `a0f7d65` before the fixes were written down:

| Claim | Result |
|---|---|
| `npm run bench` exists | **No.** `package.json` has `test`, `test:min`, `test:core`, `test:all`, `build:tui`, `typecheck`, `eval`, `export-dataset`, `bench-guards`, `bench-n7`. A2b-T3 is required. |
| Task checks run on the host via `sh -c` | **Yes**, `worktree/git.ts:285`. Also `:307` for a contract `evaluator` — two paths, both covered by A1-T12. |
| Four sites hold a raw client | **Yes.** Constructed once at `plugin.ts:1004`; used at `:1148`, `:1184`, `:1798`. `capture.ts:52` takes an `Asker`, so `N17` (`:63`) bypasses the journaling `Decider` as well. |
| A5 consumer files exist | **Yes.** `state/src/picks.ts`, `core/src/journal.ts`, `guard/src/config.ts`, `tui/src/pools.ts` all present. |
| Only G0/G0.injection/G reach the local model | **Yes**, `backends.ts:31,54`. |
| `RulesBackend` answers nothing | **Yes**, `backends.ts:43-48`; `decide.ts:682` falls to `verdict: "user"`. |
| `dataset.ts` trains only on `typesafe` rows | **Yes**, `dataset.ts:57` (user label > outcome > cloud answer). |

### 2.8 Round-3 findings and where they are fixed

Round 3 was a verification pass with two reviewers. Qwen returned **ready to execute** after confirming both host
`sh -c` paths (`worktree/git.ts:285`, `:307`), the host runner and the fail-closed rule. Luna found three items:

| # | Finding | Fixed in |
|---|---|---|
| 1 | **A2b-T5 contradicted D21**: it shipped `mode: local` *before* the bench passed, while D21 said local becomes the default only after. The gate did not control the thing it claimed to control. | **D21** and **A2b-T5** rewritten: the *mode* is `local` from day one; the bench gates **per-node floors** (`default` → `calibrated`). Nothing else changes, so there is no contradiction left. |
| 2 | A5-T5 omitted `micromanager/src/config.ts`, though A5's file list named it; and A1-T13's allowlist was a bare literal list, so a stale consumer could hide behind a legacy detector's exception. | **A5-T5**, **A1-T13** (allowlist is *path + literal* pairs) |
| 3 | B3's "first usable increment" had no **HyperFrames prerequisite**: the first setup path is A6-T6, which runs later, and B3's files did not own the dependency or its licence. | **B3-T0** (precondition + licence row), §4 wording |

Precision patches from Qwen, applied while executing rather than as plan changes:

- **A1-T12:** sandboxed gate runs must reuse the job's grants (domains, env) — `npm test` and `uv run pytest` need
  registries, and a naive sandbox would break every existing check.
- **A2-T6:** audit every client construction site, including `cli.ts:79,88` (`bench-n7` reads `apiKey()`
  unconditionally) and `runner.ts:134` (rules-only decider).
- **A3-T3:** any non-`.sample` hook file triggers `askOn`, not just `post-merge`.
- **B1-T5:** the executable allowlist is a code-owned constant, never taken from a spec; Chromium children are
  confined to the job dir and denied network unless declared.
- **A1-T1:** the no-git copy must not follow symlinks.

---

## 3. Target architecture

```
OpenCode
  └─ @omacode/full
       ├─ micromanager (orchestrator)
       │    ├─ modes: Plan | Build | Auto
       │    ├─ jobs: plan worktrees / build worktrees / merge
       │    ├─ memory, context, guard, sandbox
       │    └─ rulebook (policy + routing + guard questions)
       ├─ @omacode/context (memory, embeddings)
       ├─ @omacode/guard (redaction, privacy)
       ├─ @omacode/sandbox (shell isolation)
       ├─ @omacode/tui (TUI plugin)
       └─ @omacode/artifact (new, 0.3)
            ├─ contracts: spec | checks | provenance | adapter
            ├─ host-runner (allowlisted, argv-only, cleaned env)
            └─ adapters:
                 hyperframes | pptx | web | comfyui | wan | manim | blender
       └─ @omacode/artifactd (new, 0.4: B6)
            └─ queue | GPU lock or remote dispatch | cache | service
```

### Execution boundary

Every path that runs text a worker wrote goes through the sandbox:

```
worker tool call ──► sandbox (worker)
job gate / checks ──► sandbox, or refused in plan mode   (A1-T12)
adapter render    ──► host runner, allowlisted and argv-only (B1-T5)
merge / hooks     ──► user checkout, backup + policy (A3)
```

### Modes

`<stateDir>` is `.opencode/omacode` (A5). No task may use a literal.

| Mode | Writes | Workers | Merge | Checks |
|---|---|---|---|---|
| **Plan** | only `<stateDir>/plan/<job>/` | readers + investigators (writers refused without a sandbox) | never | sandboxed, or (D23) unsandboxed after the user's confirmation, or skipped |
| **Build** | task worktrees only | writers + readers | manual or policy | sandboxed, or (D23) unsandboxed after the user's confirmation |
| **Auto** | task worktrees only | writers + readers | autoMerge policy, backup + undo | sandboxed, or (D23) unsandboxed after the user's confirmation |

### Decider modes

| Mode | Guard questions | All other nodes | Leaves the machine |
|---|---|---|---|
| **local** | local backend | local backend | never |
| **cloud** | local unless explicitly overridden per session | cloud | yes — after redaction, preview and confirmation |

**Missing backend is not a mode.** If no local server and no cloud key exist, deterministic layers decide and the rest
asks the user; that state is reported at job start, never hidden.

### Artifact pipeline

```
brief/spec → plan/storyboard → tasks (per scene/page/slide) → checks → review → render/build → publish/export
```

The same task/check/gate model serves code, video, deck, web and images. B1-T6 makes the bridge from a plan job's
`plan.md` + `Artifacts:` to a typed spec explicit.

---

## 4. Job map

### Two tracks (D22)

**Track S — safety (0.2).** Sequential; these jobs share `plugin.ts`, `tools.ts`, `config.ts`, `native.ts`,
`decide.ts` and `agents.ts`.

**Track A — artifacts (0.3/0.4).** Starts once **A1-T8** has fixed the `plan.md` schema. It touches
`packages/artifact/` (new) and does not import A-track code, so it runs in parallel with A2–A6.

| Job | Title | Track | Depends on | Outcome |
|---|---|---|---|---|
| A1 | Plan mode hard boundary | S | — | Fail-closed plan worktrees, sandboxed checks, no merge |
| A2 | Decider: two modes, client demoted, permissions journaled | S | — | `local`\|`cloud`, no hybrid, no `refusal_likely` |
| A2b | Decider bench + numeric gate + per-node floors | S | A2 | A measured ask-rate and a gate that can fail |
| A3 | autoMerge port + policy | S | — | Guarded auto-merge, user-answered, hooks-aware |
| A4 | Memory for all agents | S | — | Every agent can search; writers can set validated |
| A5 | `.opencode/omacode` migration | S | A1–A4 | New dirs/config + safe migration, no literals left |
| A6 | Setup assistant + doctor + licenses | S | A2, A5 | Detection, skip paths, license manifest, uninstall |
| B1 | Artifact contracts + host runner | A | **A1-T8** | Spec, checks, provenance, adapter iface, safe runner |
| B3 | Deck adapter (**first slice**) | A | B1 | HyperFrames slideshow + optional PPTX + checks |
| B5 | Images + ComfyUI client | A | B1 | Shared ComfyUI client, images, territory by hash |
| B2 | Motion MVP (HyperFrames) | A | B1 | Motion video with titles/captions + QA loop |
| B2b | Generative video (Wan 2.2) | A | B1, B2, B5-T2 | Text/image → video, territory-gated |
| B2c | Manim, Blender, audio | A | B1, B2 | Math animation, 3D passes, narration |
| B4 | Web adapter | A | B1 | One build contract + Playwright/Lighthouse/axe |
| B6 | `artifactd` | A | B2b, B5 | Topology, queue, lock/dispatch, cache, budget |
| C1 | Rulebook TUI panel | UI | A2, A6 | Models/routing/guard/questions/test console |
| C2 | UI polish + worker steer input + first run | UI | C1 | Job header, settings, steer, onboarding |
| D1 | Fine-tune workflow | later | A2b | Train/eval/promote using the A2b dataset |
| D2 | Live voice | later | — | Reuse oc-voice |
| D3 | Publishing/deploy | later | B3/B4 | Preview/production publish |
| D4 | Code review | later | A3 | Internal review gate or open-pr skill |
| D5 | MCP manager | later | A6 | Profiles, pins, doctor, sandbox |

**Order**

```
Track S:  A1 → A2 → A2b → A3 → A4 → A5 → A6
Track A:      B1 → B3 → B5 → B2 → B2b → B2c → B4 → B6
UI:           C1 (after A2 + A6) → C2
```

**First usable increment:** **B3**, the third job overall (A1 → B1 → B3). A real HTML deck, presented and checked,
with no `artifactd`, no GPU and no safety track completed — on a machine where HyperFrames is already installed
(B3-T0 says so plainly; A6-T6 makes it one command).

**Sequencing.** A1–A5 stay sequential. B3, B5, B2, B4 may run in parallel after B1. B2b waits for B5-T2 and B2.
B6 waits for a real GPU render. C1 waits for A2 because the question set and the mode names come from there.

### The 1.0 cut (2026-11-21)

The plugin is finished first; a sandbox for agents (OpenCode with Omacode, Claude Code, pi) is not part of the plugin
and becomes a project of its own after 1.0. The plugin only has to run unchanged on a host and inside any container:
it takes service URLs and the token from the environment (`@omacode/core/services`, done) and prints a URL where it
would open a desktop window (container plan P3-T3).

**In 1.0**, in this order:

1. **A5** `.opencode/omacode` migration, before anyone else installs, so there is no second migration later.
2. **A4** memory for all agents.
3. **P3-T3** desktop hand-offs print a URL when there is no display.
4. **B4** web adapter.
5. **P6** decider on mmBERT (`hivetrace/gliner-guard-uniencoder`, container plan P6-T1b..T5), so 1.0 never ships the
   PyTorch-based decider.
6. **A6, slimmed**: host install with profiles, preflight, doctor, uninstall, the licence manifest, and one service
   installer (`omacode services install | status | remove`): the supervisor from `container/supervisor.ts` runs on the
   host as the single user service `omacode-services` (systemd user unit or launchd agent, generated, no repository
   paths), writes URLs and token to `$XDG_RUNTIME_DIR/omacode/services.json`, installs the decider from its `uv.lock`
   and takes `llama-server` from `PATH` or a pinned, hash-checked release. Local LLMs and ComfyUI are only detected,
   not installed.
7. **C2-T7** first run: from installed to the first deck.

**After 1.0:** A3, C1, the rest of C2, B2b, B2c, B6, D1–D5, and the container plan's P2 (launcher) and P3-T3a..T15
(gateway, trust tiers, shared services), which move to the sandbox project or are dropped there.

---

## 5. Jobs in detail

### A1 — Plan mode hard boundary

**Goal:** Plan mode cannot modify the project, and **no code path outside the sandbox can execute text a worker
wrote** — including task checks. If the sandbox is unavailable, plan jobs run reader-only and say so.

**Internal order:** T0 → T1 → T2 → T3a → T3b → T4 → T5 → T6 → T7 → T10 → T11 → T12 → T13 → T14 → T8 → T9.

**Tasks**

- [x] **A1-T0 — Path single source.** One helper answers "state dir / user state / config". `stateDir(project)` exists;
  this makes it the only way to ask. A5-T0 later replaces the consumers, but every job from A1 on uses the helper.
  - *Reality:* the helper is `packages/core/src/paths.ts` (core is the dependency leaf; state depends on it and
    re-exports `stateDir`/`DIR`/`LEGACY_DIR` unchanged). Test: `test/paths.test.ts`.
- [x] **A1-T1 — Plan worktree.** `preparePlanWorktree(project, job, task)`:
  - path `<stateDir>/plan/<job>/worktrees/<task>` via `stateDir(project)` — never a literal;
  - throwaway branch `plan/<job>/<task>` off `HEAD`;
  - no-git fallback: a **copy** of the project with exclusions — `<stateDir>`, `.git`, `.env*`, key material, files
    over a size cap — that **does not follow symlinks**, plus a test that the copy does not recurse and does not carry
    secrets.
  - *Reality:* a project without a commit cannot branch, so `preparePlanWorktree` throws `IntegrationError` and the
    caller falls back to `copyForPlan`; `.env.example` stays excluded because the existing `SECRET` rule matches it.
- [x] **A1-T2 — Plan job isolation.** `isolation: "plan"`: no integration branch, no integration worktree, no merge;
  `#merge` refuses plan jobs; `finish_task` marks `passed`, never `merged`.
  - *Reality:* the plan finish branch returns no note to the micromanager (the next-task note comes from `ended`); a
    plan task keeps its worktree until T3a promotes and discards it. `tui/src/progress.ts`'s `isolation` type widened.
- [x] **A1-T3a — Promotion validation.** For every `Artifacts:` path: `lstat` — reject symlinks, devices, sockets
  **including nested ones when the artifact is a directory**; reject absolute paths and `..` after normalisation;
  reject paths resolving outside the plan worktree; size cap; secret scan; copy into
  `<stateDir>/plan/<job>/artifacts/<task>/` **without following symlinks**.
  - *Reality:* `promoted` records one entry per file (a directory has no single hash); the copy opens each source with
    `O_NOFOLLOW` **and** checks the descriptor's dev/ino against the `lstat`, so a parent swapped for a symlink between
    check and copy is refused too. Plan worktrees of a sub-directory project are entered at the project offset
    (<worktree>/<rel>), else every report path would resolve one level wrong.
- [x] **A1-T3b — Promotion record.** `patches/<task>.patch` (`git diff base..HEAD`), `findings/<task>.md`, manifest.
  - *Reality:* the plan finish commits on the throwaway plan branch first, so `base..HEAD` is literally the patch; the
    manifest adds `patchBytes` and, without git, `patch: null` plus a note. The plan worktree is discarded once the
    record is on disk (T9's end state arrives a task early).
- [x] **A1-T4 — Plan agent profile.** Primary `micromanager-plan`:
  - `edit` deny outside `<stateDir>/plan/**`, with **explicit allow** rules for that root (`roles.ts` `noStateDir`
    otherwise denies the agent its own artifacts);
  - **read allow for `<stateDir>/plan/**` on the agents that consume a plan** — the Build-mode micromanager cannot
    read `plan.md` today, because only `backlog*` and `contracts*` are allowed;
  - subagent allowlist: `explore`, `researcher`, `plan`, `oracle`, `investigator`;
  - deny the **real** tool ids: `todo`, `run_job`, `merge_job`, `discard_job`, `rewind_job`, `take_over_job`,
    `undo_merge` (there is no `auto_merge`).
  - *Reality:* the allowlist names the agents (`explorer`, `planner`, …) as the subagent tool does, with the role-id
    mapping in a comment; `noStateDir` comes before the plan allows because the last match wins. The plan agent also
    gets the read allow for its own root (write-but-not-read was an oversight in the wording).
- [x] **A1-T5 — Investigator role.** Writer-class role that writes only its plan worktree, may run tests/builds, and
  reports `Artifacts:` / `Findings:`.
  - *Reality:* it is in both writer sets (`profile.ts` for the worktree/sandbox, `plan.ts` so its task must declare the
    draft files it writes). "May run builds" goes through the permission fast path for commands that stay in the
    worktree (T10), not the static allow list, which carries only test runners and linters. `planModeRoles()` was added
    to the planner prompt: without it the planner never names the role and a plan job could not be planned.
- [x] **A1-T6 — Write guard.** In `tool.execute.before`:
  - resolve targets with **`realpath` of the nearest existing ancestor**, not lexical `resolve`;
  - deny outside the plan root, including via symlink;
  - shell blacklist (advisory): `cd ..`, `rm`, `git checkout`, `git stash`, `git branch`, `git worktree`,
    `git config`, `git gc`, `git update-ref`, absolute paths outside the root.
  - *Reality:* the list is refused, not merely logged, where it leaves the plan root: `cd`/`rm` with `..` or an
    outside absolute path, the seven ref-moving git subcommands, any absolute path outside both the plan root and the
    session's own directory (streams and the temp dir excepted); `rm`/`cd` inside are advisory (journalled). A write
    tool whose target this layer cannot read (the `patch` tool's targets live in the patch text) is refused too —
    fail closed — with a message to use `edit`/`write`.
- [x] **A1-T7 — Sandbox profile, fail-closed.** Plan investigator: `rulesFor({ writer: true, worktree: planRoot, temp })`,
  project read-only. **If `available === false`:** the job starts **reader-only** — no writers or investigators are
  delegated — and the restriction is visible in the job status **and** in `plan.md` ("this job ran reader-only: no
  sandbox on this machine"). This is the single fail-closed rule; A1-T11 implements it.
  - *Reality:* the plan agent is a root session, so the shell plugin's child rule would leave its commands unwrapped;
    its session is now marked (`SHARED.planSessions`) and sanded with the same plan profile, or the barrier would hold
    for every agent except the one that types the most commands. A writer refused for lack of a sandbox sets
    `job.planReaderOnly` and names the reason; `readerOnlyNote()` feeds the job status (plan.md is T8).
- [x] **A1-T10 — Path rules for plan worktrees.** `decide.ts` `taskWorktree` / `inJobArea` / `staysInWorktree` do not
  recognise `<stateDir>/plan/<job>/worktrees/<task>`, so every investigator command falls to the decider. Teach the
  path rules the plan layout; test that inside-tree commands run **without** per-command asks.
  - *Reality:* one regex carries both layouts; `inJobArea` accepts the plan area as well as `worktrees/`. The
    no-ask test calls `decide(undefined, …)` (no decider at all) and still gets `allow`; `sandboxed: false` does not
    take the fast path. The reader fixture is `explorer` (the plugin's role agent), not OpenCode's `explore`.
- [x] **A1-T11 — Start condition.** `startJob` in Plan mode checks the sandbox and, when it is off, proceeds
  reader-only **with an explicit warning** (A1-T7) rather than failing silently or failing hard. The warning names the
  fix (`omacode doctor`). A6-T10 later surfaces the same check in the doctor.
  - *Reality:* a job started from the plan agent (`run_job` in a `micromanager-plan` session) becomes a plan job;
    `nextStep` takes an optional task predicate, so a reader-only job never names an investigator (both call sites
    pass it). The warning is returned with the job, not thrown.
- [x] **A1-T12 — Plan-mode check execution.** Two host-side `sh -c` paths exist and both are outside the sandbox:
  `worktree/git.ts:285` runs the task's `Checks:` (`nice -n 15 sh -c <command>`), and `:307` runs the same way for a
  contract's `evaluator`. A check line is worker-authored, and in a plan job it is promoted from an untrusted
  worktree. Therefore:
  - in Plan mode, checks run **inside** the same `rulesFor({ worktree: planRoot })` wrapper, or are **skipped** with a
    stated reason when the sandbox is off, **or** — D23 — run unsandboxed after the user confirmed it for that job;
  - in Build/Auto mode the same rule applies: a check runs in the sandboxed scope of its own worktree;
  - a sandboxed gate run **inherits the job's grants** (domains, env): `npm test` and `uv run pytest` need registries,
    and a naive sandbox would break every existing check;
  - a test asserts that a hostile `Checks:` line (`rm -rf ../..`, `/etc/passwd` write) cannot touch the project
    **at gate time**.
  - *Reality:* both host paths now take a `Gate` (`gatebox.ts`): its rules, its cleaned env and the job's grants, or
    `skip` with the reason and no execution. A skipped check blocks the task without consuming a fix round. Contract
    *baseline* evaluators have no task, so their gate uses role `code` and the integration worktree. The hostile test
    runs for real under bubblewrap on this machine.
- [x] **A1-T13 — No new literals.** A scan test, wired from A1 on, that fails on state-path literals outside an
  allowlist. The allowlist is **path + literal pairs**, not a bare literal list: the legacy detectors in A5-T2 are
  allowed to name `.micromanager` *in that file*, and nothing else may. A bare list would let a stale consumer hide
  behind a legacy detector's exception.
  - *Reality:* the scan reads the names from `paths.ts` and the allowlist entries from those constants too, so the scan
    file spells no literal and needs no entry of its own (an entry there could have shielded a stray one). A test
    asserts both names still occur in the tree, so a renamed constant cannot make the scan vacuous.
    Allowlist: 47 pairs over 25 files; both directions proven by hand (stray literal, stale entry).
- [x] **A1-T14 — Unsandboxed run, by the user's word (D23).** When no sandbox can run, nothing starts until the user
  says so for that job:
  - `unsandboxed: "ask" | "never" | "allow"` in the config, default `ask`; `never` keeps today's fail-closed path;
  - a **deterministic** risk score (0–100, band and one plain-language finding per rule) over the job's checks:
    destructive, privilege, network-execute, keys/secrets, writes outside the project, git ref moves, obfuscation,
    plain builds; a plan job scores higher because its checks come from an untrusted worktree;
  - the question is a form the plugin hands the micromanager, answered **by the user** (the answer reaches the plugin
    through `tool.execute.after`, never through the orchestrator's word): "Start without a sandbox" / "read-only" /
    "Cancel", with the score, its findings and the check lines;
  - the grant is stored per job in the control file and journaled with the score; a second start does not ask again;
  - worker shells and checks then run unwrapped, and every gate result and stage says `unsandboxed (confirmed)`.
  - *Reality:* the band follows the **worst rule**, not the arithmetic — a destructive or key-reading command reads
    `high` even when its number is 56, because the number ranks and must not reassure. The rolling-job gate fires at
    the first ungranted delegation, including a job that lost its sandbox after starting. `never` closes a stored
    grant; `allow` stores one with `by: "config"`. Contract baselines and the runner's own gate read the same field.
- [x] **A1-T8 — Plan contract.** `plan.md` schema: goal, findings, decisions, open questions, recommended tasks,
  artifacts, risks, plus `mode: reader-only` when T7 applied. Build mode reads it and starts at `execute` or re-plans.
  - *Reality:* the plugin always writes a `plan.md` from the job (no `plan.md` can be missing), so a reader-only start
    carries its mode line; a richer document the plan agent wrote itself is kept at later rewrites. `job_status` names
    the file. Build mode reads it with its ordinary read tool (the T4 rule), no new tool.
- [x] **A1-T9 — Tests.**
  - host refuses project edits by the plan agent; subagent allowlist refuses `coder`;
  - **Build-mode agent can read `plan.md`** (T4's read allow);
  - **symlinked (including nested) artifact rejected**; `..` rejected; absolute path rejected;
  - **sandbox unavailable ⇒ no investigator, and the job says reader-only**;
  - shell cannot write outside the plan worktree, including `node -e` / `sed -i` with the sandbox on;
  - investigator's own commands cause **no** per-command asks (T10);
  - **a hostile `Checks:` line cannot write the project at gate time** (T12);
  - artifacts promoted, worktree discarded; `merge_job` absent; no-git copy excludes secrets; scan test (T13);
  - **without a recorded confirmation, no check runs unsandboxed**; with one, it runs, is marked `unsandboxed`, and
    the score and the grant are journaled (T14).
  - *Reality:* three cases were added where the task-by-task work left a gap: a real-bubblewrap test that a plan worktree
    cannot write the project through `node -e`/`sed -i`; `discard_job` removing a **live** plan worktree (lost when T3b
    began discarding at finish); and the end-to-end acceptance test (plan.md + artifacts + byte-identical project + no
    merge path + worktree gone). Two bullets rest on a pair of tests because their hook bodies are inline in
    `plugin.ts`: the plan agent's edit refusal (`PLAN_AGENT.rules` + `writeGuard`) and `merge_job` absence (tool-id
    denies + `mergeJobInto`). The T14 addition is covered by `sandboxgate.test.ts` (decision, form, and the grant
    written to the control file and the journal).

**Files:** `packages/micromanager/src/{agents,tools,plugin,native,decide,forms,config,riskscore}.ts`, `worktree/git.ts`,
`packages/sandbox/src/sandbox.ts`, `packages/state/src/roles.ts`, `test/{native,integration,plan,permissions}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`, `npm run test:all`; integration test on a temp git repo; one test with the
sandbox forced off; one with a hostile check line.

**Acceptance:** a plan job produces `plan.md` + artifacts, touches no project file, has no merge path, runs no check
outside the sandbox **unless the user confirmed it for that job (D23, recorded with its risk score)**, and is
explicitly reader-only when the sandbox is unavailable and no confirmation was given.

**Risks:** shell writes bypass path parsing — the sandbox is the barrier. Gate checks and the host runner are the two
places where the harness itself executes worker text; both are owned (T12, B1-T5).

---

### A2 — Decider: two modes, client demoted, permissions journaled

**Goal:** Two modes (`local`, `cloud`), no hybrid. The cloud client is renamed, only constructible in `cloud` mode, and
redaction is enforced **inside** it. `refusal_likely` is gone and the rulebook re-benchmarked.

**Tasks**

- [x] **A2-T1 — Modes.** `decider.mode: "local" | "cloud"`. Backends: `gliner` (local), `openjev` (local, disabled
  when no server is installed), `cloud` (was `typesafe`), `rules`. `cloudOnly` is removed; `default`/`nodes` become
  per-node overrides only. Config migration maps old values and **logs the migrated mode loudly** (`cloudOnly: true`
  must not silently become `mode: cloud` without a line in the upgrade output).
  - *Reality:* no backend was ever parsed from the file — `default`/`nodes` lived only in `DEFAULT_BACKENDS` — so migration applies to the mode only, and a stale backend id falls back to `rules` with the type error it always was.
- [x] **A2-T2 — Demote, don't delete.** Remove the **keyring requirement** and the implicit default. One client,
  constructible only when `mode === "cloud"`. No keyring read in `local` mode.
  - *Reality:* the keyring and the implicit default are gone; one class, constructible only in cloud mode, and local mode reads neither key nor URL (a test makes the URL getter throw).
- [x] **A2-T2b — Journal permission decisions.** Route `decide()` through the decider so each permission case records
  the request, the **state text sent**, the questions, and the answers. Today `plugin.ts:1798` calls the raw client and
  only `Decider.ask` journals (`backends.ts:113`), so the inputs cannot be reproduced for training. `capture()`
  (`packages/context/src/capture.ts:52,63`) has the same shape: it takes a raw `Asker`, not the `Decider`, so `N17`
  decisions are unjournaled too. (Was A2b-T1; it belongs here because A2-T9 depends on it.)
  - *Reality:* the `decision` entry gained `mode`, `request`, `sent` and `egress`; the preview answer is its own entry, like a grant, because it arrives long before the decision exists. `sent` is the JSON state the client posted, not a bare string.
- [x] **A2-T3 — Rename.** `jev.ts` → `decider.ts`; `Jev` → `DecisionClient`; `JevError` → `DeciderError`. Docs say
  "decision client". The local servers keep the same wire format.
  - *Reality:* `JevOptions`/`apiKey` moved with the class (`DecisionClientOptions`/`cloudApiKey`); the local servers' wire format is untouched.
- [x] **A2-T4 — Drop `refusal_likely`.** Remove from `catalog.ts`, `gate.ts`, `backends.ts`, `schema.ts`, tests, docs,
  bench. Guards become `injection`, `harmful`, `sensitive`. **Bump the rulebook version.** The eval re-run moves to
  A2b, because the labels come from the journal and the cloud client is being demoted in this same job.
  - *Reality:* **no rulebook existed yet** (C1-T1 ships it), so the version was introduced as `RULEBOOK_VERSION = 2` and is journalled on every decision; the bench re-run stays with A2b. The routing that used the removed number is an `uncensored` reroute, so runtime behaviour stays.
- [x] **A2-T5 — Cloud mode.** Every node may ask cloud, after the T6 flow: per-session opt-in, re-confirmed per session;
  journal records mode, backend and that text was sent; guards stay local unless overridden **for that session only**.
  **"Unredactable" is defined:** the payload carries a `sensitive` guard flag, **or** redaction changed nothing in a
  non-trivial text (> 20 words). Overriding is refused for unredactable payloads.
  - *Reality:* the opt-in is per session, forgotten when the session ends, and re-asked after twelve hours or a different real job id; memory/compaction paths pass a source rather than a job, so only `job-…` ids count as a change. A root micromanager session has no parent to put the form to and stays local; delegated workers can opt in.
- [x] **A2-T6 — Redaction, enforced in one place.** Deterministic redaction (emails, paths, tokens, keys, IPs, env
  secrets) implemented **inside `DecisionClient`** — or one wrapper that every call goes through — because four sites
  hold a raw client and would otherwise bypass it, all constructed at `plugin.ts:1004`: `plugin.ts:1148` (grant
  harmless check), `plugin.ts:1184` (`check_bug`), `plugin.ts:1798` (`decide()`), and
  `packages/context/src/capture.ts:63` (`N17`, which receives an `Asker`, never the journaling `Decider`). Then:
  - **audit every construction site**, not only the plugin's: `plugin.ts:1004`, `cli.ts:79,88` (`bench-n7` reads
    `apiKey()` unconditionally) and `runner.ts:134` (a rules-only decider) — each must go through the same wrapper;
  - **no local NER ⇒ every payload is treated as uncertain ⇒ preview + explicit confirm on every cloud call**
    ("send", "keep local", "cancel");
  - local NER ⇒ redact names/orgs, preview, allow "send";
  - no confirmation, no request.
  - *Reality:* the gate lives in `DecisionClient.ask`, the only place a request is made, so no raw client, CLI or test can bypass it; the preview rides the existing deferred-form path with Send/Keep local/Cancel. The two detectors it lacked (home-path prefix, IPv4) were added next to the existing ones.
- [x] **A2-T7 — Service rename.** `decider/jev-decider.service` → `decider/decider.service`; package/script `decider`.
  - *Reality:* the unit, the pyproject project/script and `uv.lock` are `decider`; the server's startup line says so too.
- [x] **A2-T8 — Docs.** `README.md`, `docs/design.md` §20/§21, tool descriptions; and a note that `cloud` without NER
  costs a confirmation round-trip per call, which may be worse than `local` + ask.
  - *Reality:* README and design §20/§21 describe the modes, the demoted client and the round trip cloud-without-NER costs; the old design sections still say Jev, which is history rather than a tool description.
- [x] **A2-T9 — Tests.**
  - `local` mode: **no cloud key and no cloud URL** is read or constructed. (Not "no client": the local backends are
    the same client class — `backends.ts:55-56`.)
  - `cloud` mode without confirmation sends nothing, from **each** of the four direct call sites.
  - guards never reach cloud without a per-session override.
  - `refusal_likely` appears nowhere (`grep`).
  - permission path degradation is journaled (T2b), not silent.
  - migration from `cloudOnly: true` reports the new mode.


  - *Reality:* the audit filled the gaps it found (local never reads the cloud URL, all four sites send nothing without a confirmation, guard override through the real `CloudOptIn`, degradation journaled, exact migration sentence). The inline `plugin.ts` hook bodies are proven at the function they call, not end to end — the same limit A1-T9 recorded; a decider that throws before journaling is structurally unjournalable and says so.**Files:** `packages/micromanager/src/{backends,decider,catalog,gate,config,plugin,plan,runner}.ts`,
`packages/context/src/capture.ts`, `decider/`, `docs/design.md`, `README.md`,
`test/{backends,decide,guard,session,runner,permissions}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`, `npm run test:all`;
`grep -r "JEV_API_KEY\|api.typesafe.ai\|refusal_likely\|cloudOnly"` returns nothing.

**Acceptance:** `local` sends nothing; `cloud` sends nothing without a shown preview and a confirmation, from every call
site; `refusal_likely` is gone; permission decisions are journaled with their inputs.

**Risks:** removing the implicit default turns previously-answered decisions into user prompts — intended, and
measured in A2b before anything flips.

---

### A2b — Bench, numeric gate, per-node floors

**Goal:** Make "local decides" a measured claim, with a gate that can actually fail.

**Tasks**

- [x] **A2b-T1 — Export.** Add `PERMISSION_QUESTIONS` + `path_relevance` to the `dataset.ts` GLiNER2 JSO export,
  **and the non-guard nodes** (`N1`, `N2`, `N4`, `N5`, `N7`, `N8`, `N10`, `N14`, `N15`, `N16`, plus the `git` node).
  Today only `G0`/`G0.injection`/`G` reach the local model (`backends.ts:54`), so a local decider that answers only
  guards does **not** reduce the ask storm.
  - *Reality:* the export is built from journaled decisions, so a node that never runs cannot manufacture rows; the local model's scope is now explicit (`LOCAL_NODES`, `localQuestions`) and permission cases plus the non-guard nodes are exported as soon as they are decided. N8 and N16 still share one `in_loop` task id on the wire — a real collision left open rather than renamed under a served model.
- [x] **A2b-T2 — Labels.** Keep the priority (user label > outcome > cloud answer); add outcomes for permission cases:
  allowed-and-succeeded, denied-and-retried, user-overrode.
  - *Reality:* the outcome vocabulary and `labelPermission()` exist and round-trip, but nothing in the repo observes "succeeded" or "retried" yet, so no automatic caller exists; labels arrive from the journal when someone records them.
- [x] **A2b-T3 — A real bench command.** `npm run bench` must **exist**; `package.json` has only `eval`,
  `bench-guards`, `bench-n7`. Wrap them into one command that runs guards **and** permissions and prints a table.
  - *Reality:* `npm run bench` runs guards, permissions and N7 in one process with one table instead of shelling out to the old commands — same effects, no duplicated setup.
- [x] **A2b-T4 — Numeric thresholds, per node.** State them in the plan, not later:
  - guard questions: precision ≥ 0.95 on `harmful`, recall ≥ 0.90, on a corpus of ≥ 300 labelled cases;
  - permission cases: false-allow rate ≤ 0.01 (a wrong allow is the expensive error), ask-rate ≤ 30 % of shell
    decisions in a normal build job;
  - corpus version pinned in the bench output; a change of question wording bumps the version and the corpus;
  - **a node that does not pass stays on the default floors** (T5) — passing is per node, not per model.
  - *Reality:* the thresholds live in `bench.ts` and `bench/A2B.md` (there is no plan document beside the roadmap). Only `harmful` has stated precision/recall, so only that clause is gated; injection and sensitive are printed, not gated, because gating them would mean inventing numbers.
- [x] **A2b-T5 — The gate is about floors, not the mode.** `mode: local` ships from day one; T4 gates
  `decider.floors: "default" | "calibrated"`.
  - `default`: the conservative floors already in `decide.ts` (read 0.8, write 0.85) apply to **every** node.
  - `calibrated`: a node's measured floors apply, **only for nodes that passed T4**, one node at a time.
  - The job-start line reports the ask-rate and which nodes are still on default floors.
  Nothing escalates to cloud in either state, so the mode never changes and there is no contradiction to resolve at
  runtime.
  - *Reality:* `decider.floors` is `default`/`calibrated`; permission journal entries had no job id, so the ask-rate needed `job` at the record site, and older entries fall back to the last 200 shell decisions — the job-start line says which scope it used.
- [x] **A2b-T6 — Tests.** Journal round-trip; export shape (guards **and** permissions); floor application; a bench
  fixture that can pass and one that must fail; the gate refusing the flip; a threshold change without a corpus bump
  fails.


  - *Reality:* the bench fixture fails as it should: on 2026-11-16 no node passes (guards: 16 cases, harmful precision 20 %, recall 33 %; N13: false-allow 7 %, ask-rate 82–100 %), so every node stays on the default floors.**Files:** `packages/micromanager/src/{decide,dataset,bench,backends}.ts`, `package.json`, `bench/`,
`test/{decide,dataset,bench}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`, `npm run bench`.

**Acceptance:** `npm run bench` exists and prints per-node precision/recall and the ask-rate; the gate fails on the
current model; the numbers are written down.

**Risks:** labels need usage, usage needs shipped jobs — before enough data exists the bench runs on fixtures and user
labels only, and the gate will honestly fail. That is the intended outcome, not a bug.

---

### A3 — autoMerge port + policy

**Goal:** Reuse the archived implementation, with a guarded policy that a non-technical user can trust.

**Tasks**

- [ ] **A3-T1 — Port from the tag.** Source is **tag `archive/automerge`** (`src/automerge.ts` + its 18 tests at
  `431c712`), not a directory. Its imports moved to `@omacode/state`; adapt them and **re-baseline the test suite**
  against the tag's real tests.
- [ ] **A3-T2 — Resurrect the merge path.** `mergeIntoCheckout` does **not exist at HEAD**; port it and re-implement
  against the current `worktree/git.ts`: checkout/branch validation, detached/busy/dirty handling, rebase in the job
  worktree, checks after rebase, fast-forward only, reset on refusal.
- [ ] **A3-T3 — Policy, defaults, hooks.** `autoMerge` boolean|object: `mode: off|guarded|always`; `target: main|preview`;
  `require: checks|clean-worktree|fast-forward`; `maxFiles`, `maxChangedLines` evaluated **before** any merge attempt;
  `deny` paths (default `.env*`, `.git/**`, lockfiles, CI config); `askOn`; `backupRef`.
  - Every ask is `hard: true` and routed to the **user** — in Auto mode a soft "user" verdict is parked to the
    orchestrator (`plugin.ts:1574-1588`), which would let the requesting agent approve its own merge.
  - Backend `rules` (cannot answer) ⇒ **no merge**.
  - **Git hooks:** if `core.hooksPath` is set, or **any non-`.sample` hook file** exists (`post-merge`, `pre-push`,
    `post-checkout`), auto-merge becomes `askOn` by default — husky and friends run arbitrary commands in the user's
    checkout after a merge.
- [ ] **A3-T4 — Hooks + persisted state.** Runner `#verify` and native `onIdle`; complete/halted/undo; one merge per
  job **persisted** (`autoMerged`, backup ref name) so a restart cannot re-open the merge/undo window.
- [ ] **A3-T5 — Backup + notes + prune.** `refs/backups/<job>-<timestamp>` before merge; plain-language note; journal
  `auto: true`; notification; prune on `discard_job`.
- [ ] **A3-T6 — Tests.** Port the 18; policy matrix; backup ref; denied paths; max files/lines; `target: preview`;
  manual merge clears undo; undo after auto; restart during merge is idempotent; **a failing `post-merge` hook makes
  the merge ask instead of running**.

**Files:** `packages/micromanager/src/{automerge,config,plugin,runner,native}.ts`, `worktree/git.ts`,
`test/{automerge,tools,integration}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`, `npm run test:all`; real-git integration.

**Acceptance:** a low-risk job auto-merges with a backup; a high-risk one asks the user; undo restores; a dirty checkout
is never force-touched; a checkout with hooks asks; a restart cannot merge twice.

**Risks:** `allowDirty` semantics; backup-ref creation failure (fail closed); merge race; hooks firing in the user's
checkout (now owned by T3/T6).

---

### A4 — Memory for all agents

**Goal:** Every agent can search memory; primaries/writers can write with validation.

**Tasks**

- [x] **A4-T1 — Access matrix.** `memory_search`: all agents; `list`/`get`: primaries + readers; `set`/`replace`:
  primaries + writers.
- [x] **A4-T2 — Stop deleting search.** Remove the `shapeContext` line that deletes memory tools for non-micromanager
  agents; keep the summarizer tool-less.
- [x] **A4-T3 — Core memory.** Verify core memory is injected for every non-summarizer session.
- [x] **A4-T4 — Writer writes.** Writers may `memory_set`; keep duplicate/contradiction checks and `LEARNED` capture.
- [x] **A4-T5 — Tests.** Native build/plan, writer, reader, summarizer; duplicate; contradiction; memory off.

**Files:** `packages/context/src/tools.ts`, `packages/micromanager/src/plugin.ts`,
`test/{context,plugin-family}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`.

**Acceptance:** every agent can search; a writer can store a validated fact; the summarizer has no tools.

**Risks:** writers storing noise → keep capture validation and caps.

*Done 2026-11-21:* one table, `MEMORY_ACCESS` in `context/tools.ts`, decides both the tool list (`shapeContext`) and
a refused call; "primary" is every agent that is not a worker role or the summarizer. Writer roles lost their
`memory_set`/`memory_replace` deny rule (`state/roles.ts`, `WRITER_ROLES` now lives there); every role keeps
`journal_write` denied. Core memory was already injected for every session but the summarizer's; a test holds it.

---

### A5 — `.opencode/omacode` migration

**Goal:** New paths with a safe migration and **no literals left behind**.

**Tasks**

- [x] **A5-T0 — Consolidate the abstraction.** A1-T0 created the helper; this replaces the remaining consumers. Every
  path answer goes through it. *Done 2026-11-21 for the project state:* `core/paths.ts` has `STATE_DIRS`,
  `inStateDir` and `splitState`; the regexes and globs of `decide.ts`, `plan.ts`, `roles.ts`, `look.ts`, `nogit.ts`
  and `tui/progress.ts` are built from them. The literal scan now also finds an escaped name in a regex, which is how
  `decide.ts` had hidden one.
- [x] **A5-T1 — Paths + namespace pre-check.** `<project>/.opencode/omacode/` (jobs, worktrees, plan, backlog, control,
  contracts, notes, trials); `~/.local/state/omacode/`; `~/.config/opencode/omacode.jsonc`. **Before any consumer
  rewrite**, verify that writing job state under OpenCode's own `.opencode/` namespace is not host-scanned or treated
  as plugin config; if it is, this task blocks the rename and `.micromanager` stays.
  *Checked 2026-11-21 against OpenCode 2.2.5:* nothing below `.opencode/omacode/` is loaded as an agent, command, mode
  or plugin, also from a session inside a worktree there (agents found only in `.opencode/agent/`, the control), and
  a write there triggers no config reload. **But OpenCode watches `.opencode/` recursively with inotify:** 800
  directories under `.opencode/omacode/` raised its watches from 356 to 1156, the same under `.micromanager/` left them
  at 355. Worktrees with `node_modules` would cost one watch per directory each and send every checkout, install and
  build through OpenCode's watcher. **The pre-check blocks `.opencode/omacode/`.** One more rule found on the way: a
  session in a worktree reads every `opencode.json` in the directories above it, so nothing may write one into the
  state directory.
  *The user's decision the same day:* stay in `.opencode/` all the same ("it is OpenCode with a plugin"); the watch
  cost is documented, `node_modules`/`.git`/`.venv`/`__pycache__` are not watched, and worktrees go when merged.
  *User level, done 2026-11-21:* `~/.local/state/omacode`, `~/.local/share/omacode`, `omacode.jsonc`,
  `omacode-models.json`, each with its old name as fallback (`core/paths.ts`), moved by `npm run migrate -- --user`.
- [x] **A5-T2 — Legacy detection.** `.micromanager/`, `.jev-micromanager/`; config fallback; user-state fallback. These
  legacy literals are **allowlisted in the T13 scan**.
- [x] **A5-T3 — Migration.** Idle check; move/copy; rewrite JSON paths; `git worktree move` / `git worktree repair`;
  `omacode migrate --dry-run|--apply`. **No in-project symlink** — an old-path hit produces a warning with the migrate
  command instead. *Done 2026-11-21:* `npm run migrate -- --project <dir> [--apply]` (`state/migrate.ts`); a project
  on an old directory gets a one-sentence note per session instead of a symlink. User state and config: second step.
- [x] **A5-T4 — Git exclude.** Exclude `.opencode/omacode/`; keep backlog/contracts exceptions; `.gitignore` inside the
  state dir. *Done:* `**/.opencode/omacode/*` with the two exceptions. No `.gitignore` inside the state directory: it
  would itself show up as untracked, and the exclude file already covers every clone the plugin runs in.
- [x] **A5-T5 — Consumer inventory (complete).** `state/roles.ts` (deny rules), `state/picks.ts` (`micromanager.jsonc`,
  `micromanager-models.json`), `state/control.ts`, `core/journal.ts` (user state, journal, and `heldOutRoot()` — which
  is also the sandbox deny-read and the A2b dataset source), `guard/src/config.ts`, `micromanager/nogit.ts` (`OWN`),
  `look.ts`, `plan.ts` (worktree regex), `decide.ts` (job area), `runner.ts`, `backlog.ts`, `budget.ts`, `config.ts`,
  `graph.ts`, `worktree/git.ts`, `tools.ts` (tool descriptions), `sandbox.ts` (deny-read, `tempRoot`),
  `tui/switcher.ts`, `tui/progress.ts`, `tui/pools.ts`. Plus `test/` fixtures.
- [x] **A5-T6 — Tests.** Fresh project; legacy project; running job defers; worktree repair; config fallback; the
  allowlisted scan (T13) stays green; no duplicate state. *Done:* `test/migration.test.ts`, `test/project-move.test.ts`,
  `test/paths.test.ts`; config fallback comes with the user-level step.

**Files:** `packages/state/src/{store,control,roles,picks}.ts`, `packages/core/src/journal.ts`,
`packages/guard/src/config.ts`, `packages/micromanager/src/{plugin,config,nogit,look,plan,decide,runner,backlog,budget,
graph,tools}.ts`, `packages/micromanager/src/worktree/git.ts`, `packages/sandbox/src/sandbox.ts`,
`packages/tui/src/{switcher,progress,pools}.ts`, `docs`, `scripts`, `test/{store,state,migration}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; migration smoke on temp repos.

**Acceptance:** new path used everywhere (allowlisted scan clean); old projects migrate without broken worktrees; no
duplicate state; the namespace pre-check passed.

**Risks:** running jobs; git worktree metadata; OpenCode's `.opencode/` namespace (T1's pre-check can block the rename).

---

### A6 — Setup assistant + doctor + license manifest

**Goal:** One command installs the chosen stack; detects resources; never forces downloads; records and **enforces**
licenses.

**Tasks**

- [ ] **A6-T1 — Extend, don't rewrite.** `install.sh` already does one-command install, `--embedding`, a user service,
  TUI wiring and `--remove`. Extend it; `npx @omacode/setup` is the front door.
- *Status 2026-11-24 (1.0 slice):* `packages/micromanager/src/setup.ts` + CLI `preflight | doctor | setup <profile>|ask |
  uninstall [--purge] [--dry-run]`; install.sh installs what is required and missing after one question (Node in the shell; git, bubblewrap via
  pacman/apt/dnf/brew; OpenCode with its installer), then asks each optional part on its own with its purpose and
  download (services, Chromium, ffmpeg, HyperFrames, ComfyUI, comfy-mcp, Manim; uv comes along when needed);
  `--profile`/`--with` give the answers up front; `--doctor`, `--remove` via the CLI. Since then install.sh asks only
  the sudo parts (Chromium, ffmpeg); the rest is installed inside OpenCode (features.ts): the welcome asks what the user
  wants to make, `/setup` lists and installs parts, agents call `install_feature` (permission asked via
  `ctx.permission.assert`, denied to workers) and `make_artifact`/`image_models` name what is missing; comfy-mcp 0.10.0 is a fourth creative tool
  (uv tool + `mcp.servers.comfy`). Doctor calls `hyperframes doctor` and counts only what decks and videos need.
  Walked in a throwaway XDG profile: install → doctor → remove. Licence manifest (T9): `licenses/components.json` →
  `npm run licenses` → `licenses/third-party.json` + `THIRD_PARTY.md` (SPDX, territory, commercial use of output,
  attribution; npm from the lockfile, the decider's Python environment from its metadata), tests tie it to the pins.
  Still open: the compact licence block in agent context and a `license_info` tool (T9), local-LLM detection (T4),
  Blender (T6), macOS walkthrough.
- [ ] **A6-T2 — Preflight.** OS/arch/Node/git/uv/ffmpeg/Chromium/RAM/GPU/VRAM/disk/OpenCode version/TUI slot API/
  sandbox availability.
- [ ] **A6-T3 — Profiles.** Minimal/Coding/Creator/Full/Custom; `--yes` preselects; `--skip-all` installs nothing.
- [ ] **A6-T4 — Local LLMs.** Detect llama.cpp/llama-swap/Ollama/LM Studio/vLLM; recommend by VRAM/RAM; mark local;
  cloud keys; skip.
- [ ] **A6-T5 — Decider.** CPU/RAM/uv check; install the local decider + model; user service. Words this honestly:
  the installed model answers **the guards** reliably; the other nodes only improve once A2b's training data exists.
  Near-mandatory in Minimal/Coding; "ask me everything" is an explicit opt-out with the consequence stated.
- *2026-11-23, by the user's request:* install.sh asks about HyperFrames, Manim and ComfyUI and installs each at a
  pin into the home (`packages/micromanager/src/creative-tools.ts`, `npm run tools`); ComfyUI on the NVIDIA, AMD or
  integrated Radeon GPU found, or the CPU, with a PyTorch check after the install. Still open in T6/T7: `hyperframes
  doctor`, Blender detection, model recommendations and territory for ComfyUI.
- [ ] **A6-T6 — Video/motion tooling.** Detect Node/ffmpeg/Chromium; **call `hyperframes doctor`**; detect Manim/LaTeX
  (skip with "no math animations"); detect Blender. **Do not install `artifactd`** — it does not exist until B6.
- [ ] **A6-T7 — Images.** ComfyUI local/remote/API/skip; model recommendations; license/territory; no automatic
  multi-GB download; no model → skip.
- [ ] **A6-T8 — Embedding.** 0.6B/4B/8B; existing endpoint; cloud with warning; keyword-only.
- [ ] **A6-T9 — License manifest.** `third-party.json` + `THIRD_PARTY.md`: SPDX **per package**, territory, allowed use,
  **commercial-use-of-output**, attribution, acceptance; a compact block in agent context; `license_info` tool.
- [ ] **A6-T10 — Doctor.** Plugin, decider, ffmpeg, Chromium, HyperFrames, ComfyUI, models, disk, services, config,
  licenses, **sandbox availability** (the plan-mode precondition), removal hints.
- [ ] **A6-T11 — Uninstall.** Removes services, config and symlinks; says what it leaves (models, caches).
- [ ] **A6-T12 — Tests.** Detection fixtures; decision tree; non-interactive; dry-run; idempotency; EU-excluded block;
  `--skip-all`.

**Files:** `packages/setup/`, `install.sh`, `scripts/release.mjs`, `docs`, `test/setup.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; `setup --dry-run`; `omacode doctor`.

**Acceptance:** one command installs the chosen stack; nothing unwanted is downloaded; license/territory warnings are
shown; doctor is actionable; uninstall exists.

**Risks:** scope creep; platform differences. Linux first, macOS second.

---

### B1 — Artifact contracts + host runner

**Goal:** Four contracts plus the one thing every adapter needs: running a tool outside the worker sandbox — **safely**.

**Depends on:** **A1-T8** (the `plan.md` schema) and nothing else from track S.

**Tasks**

- [x] **B1-T1 — Spec.** `video.json`, `deck.json`, `site.json`, `images.json`: schema + validation + version.
  - *Reality:* hand-written, strict validation with no dependency (a new library would be a new contract to keep). Unknown
    keys are refused at every level, because a silently dropped typo lets two different specs hash the same. Paths are
    checked lexically here and resolved against the real job only by the host runner (T5). A spec's `checks` selects
    check ids; it can never define one.
- [x] **B1-T2 — Checks registry.** L0 contract, L1 mechanical, L2 visual, L3 human; per artifact type; exit codes; a
  check may be `skipped` with a reason, never silently absent.
  - *Reality:* a level is not cut short by one failure inside it (the remaining checks of that level still run); only the
    next level is skipped, with the failed ids in the reason. A skip is an absence with a reason, not a pass: `evaluate`
    lists it and leaves the "is a skip acceptable" call to the quality gate (T7). Level and producer must agree — a
    program cannot declare an L0 check, a person is the only L3.
- [x] **B1-T3 — Provenance.** Tool/model/version/seed/license/territory/input hashes; asset manifest; derived from the
  **model file hash** where a file exists.
  - *Reality:* a model's `verified` flag says whether the hash was computed from the file or merely declared, because a
    remote model cannot be hashed here and hiding that would make the record look stronger than it is. The manifest is a
    separate value with its own `manifestOf`/`verifyManifest` rather than a member of the provenance record; an extra
    file on disk is not an error (the manifest is a lower bound). `writeProvenance` chmods after writing, because the
    mode only applies at creation.
- [x] **B1-T4 — Adapter interface.** `prepare`, `render`, `snapshot`, `check`, `openEditor`, `cancel`.
  - *Reality:* the runner the adapter is given (`HostRunner`) is declared next to the adapter, because that file is the
    consumer; `runner.ts` implements it. The allowlist must be a bare program name, and a shell, a path, `node --version`
    or a leading dash is refused at declaration — a shell in the allowlist turns argv back into a command string. The
    adapter reaches the runner only through `hostRunnerFor`, which copies and freezes `executablesOf()`, so a later
    mutation of the adapter's array cannot widen it.
- [x] **B1-T5 — Host runner (constrained).** The runner is the harness executing a program on the user's machine, so it
  is an allowlist, not a shell:
  - executes **only adapter-declared executables** as **argv arrays** — never `sh -c` over spec text, never a command
    string from a spec; the allowlist is a **code-owned constant in the adapter**, never read from a spec;
  - `cwd` constrained to the job directory; arguments that are paths are resolved and must stay inside it;
  - environment built from `cleanEnv` (no inherited secrets); no network unless the adapter declares it;
  - child processes (a Chromium, a renderer) inherit the same `cwd` and network restriction;
  - timeout, output cap, kill switch, one job at a time.
  B6-T6 extends this; it does not introduce it.
  - *Reality:* "no network" is enforced by bubblewrap's argv (the sandbox runtime wraps shell strings only, which is the
    one thing this runner must not do); without a runnable `bwrap` an undeclared-network run is **refused**, fail closed.
    `HOME`/`TMPDIR` are moved into the job and `DENY_READ` is mounted away, so a renderer cannot read the user's keys —
    with `network: true` no wrapper is used at all, so neither applies (documented consequence). A program that resolves
    into the job dir — through a search directory in the job, or a symlink in a writable PATH directory — is skipped.
    Refusals and cancellations are results (`refused`, `cancelled`), never throws. A run may reach the network only where
    the adapter declared it **and** the call asks for it (a declaration is permission, not a default), and an adapter may
    declare env names whose values a run supplies — that is how a tool inside bubblewrap is told that it is inside one.
    The mounts are ordered root-then-`/dev`: the other order left `/dev/null` read-only and `spawn` with `stdio: "ignore"`
    failed with EACCES.
- [x] **B1-T6 — Plan → artifact handoff.** Map `plan.md` + `Artifacts:` into a typed spec. Needs the schema only.
  - *Reality:* `plan.md` carries no fps, frame size, scene duration, image prompt or image size, so each is a named
    default with a warning — an adapter must not invent the number the handoff already picked. A site page is addressed
    by its path inside the site, so two tasks promoting `index.html` would write one page twice: that collision is
    refused naming both tasks. Every artifact is verified (path inside the root, size and sha256 against the document),
    and a plan that promotes nothing the kind can use is an error, not an empty spec.
- [x] **B1-T7 — Output-quality gate.** What "worth shipping" means per artifact type (deck: readable without narration,
  one idea per slide, no overflow; video: every scene passes its acceptance).
  - *Reality:* a skipped L0/L1/L2 check is not shippable (a file nobody checked is not "verified"), while a skipped L3
    is a warning — nobody has looked yet is the normal state of a fresh artifact. The visual rule requires a **passed
    L2** check of the kind, so a deck without an overflow/blank-slide check can never ship, which is why B3's
    browser-backed check is part of its acceptance. Images need `outputs` (a rendered placeholder counts), because a
    slot with no file is a blank slot.
- [x] **B1-T8 — Tests.** Spec validation; checks ordering and skip semantics; provenance from a fake model file;
  **host runner refuses an arbitrary executable, an unsafe environment and a path outside the job dir**; handoff from a
  fixture `plan.md`.
  - *Reality:* the acceptance test runs the whole chain in one place — fixture `plan.md` → deck spec → fake adapter whose
    `prepare`/`snapshot` really run `node` through the host runner → manifest → checks → quality gate `ship` → provenance
    round-trip → the same runner refusing `sh -c "touch pwned"` with no file left behind. Its L2 visual result is
    synthetic by nature: B1 has no browser-backed check, B3-T4 owns that. "The allowlist never comes from a spec" is
    proven by the spec parser refusing an `executables` key — a spec has no field in which to name a program.

**Files:** `packages/artifact/`, `packages/micromanager/src/artifact/`, `test/artifact.test.ts`.

**Checks:** `npm run typecheck`, `npm test`.

**Acceptance:** a spec validates, a fake adapter runs through the constrained host runner, the runner rejects an
undeclared executable, checks report with exit codes, and a fixture plan produces a spec.

**Risks:** contract churn once the first real adapter lands — B3 follows immediately.

---

### B3 — Deck adapter (first vertical slice)

**Goal:** A real HTML deck, presented and checked, end to end. No GPU, no `artifactd`.

**HyperFrames is a precondition, not a dependency on another job.** B3-T0 checks it and gives an actionable message.
A6-T6 later automates the install; B3 works on a machine where HyperFrames is already installed.

**Tasks**

- [x] **B3-T0 — Precondition and licence.** `hyperframes --version` (and `hyperframes doctor` for detail); when it is
  missing, fail with the install command and the reason. Record HyperFrames' licence and territory in the artifact
  provenance (B1-T3) on first use, so a produced deck carries it.
  - *Reality:* the version is the gate, `doctor` only the detail (its first six lines ride along in `detail`, so a
    diagnosis never decides the start). Every failure names the install command, and the version is parsed out of a
    banner (`hyperframes v0.9.54`) as well as a bare number. The real test runs the machine's HyperFrames through the
    host runner under bwrap, not `which`.
- [x] **B3-T1 — Deck spec.** `deck.json`/`deck.md`: slides, notes, reveals, branches, hotspots, assets, checks.
  - *Reality:* `deck.json` only — the handoff writes a JSON spec and nothing reads a markdown form yet; `deck.md` stays
    open. The version is per artefact kind (deck 2, the other three stay 1, D24's direction): a shared counter would
    have made three unchanged specs invalid. The strictness survives the new nesting: a hotspot naming no branch, a
    branch called `main` (the player's own id), a slide id used twice across the main line and a branch, and duplicate
    reveal indices are refused before a project is written.
- [x] **B3-T2 — HyperFrames slideshow.** Generate a project; `hyperframes present` / `snapshot`; **never
  `hyperframes render` on a deck**.
  - *Reality:* a deck is a composition whose scenes are nested `[data-composition-id]` elements, plus the slideshow island
    (`slides`/`slideSequences`, `fragments` in absolute seconds); `present` re-serves the project with its own player, and
    a no-op `window.__timelines` registration is mandatory even for a static deck. The generated project is
    self-contained — no CDN, no external script — so it runs with the network unshared. Chrome is found through
    `<job>/.home/.cache/hyperframes/chrome` → the real cache, because the runner has no per-run env. Two runner fixes came
    out of this: the bwrap mounts were in the wrong order (`/dev` became read-only and `spawn` with `stdio: "ignore"`
    failed with EACCES), and a run may now **narrow** the adapter's network declaration — a deck check asks for none and is
    wrapped, while `present` needs the host network because its server listens inside the child's namespace.
- [ ] **B3-T3 — PPTX optional.** *(deferred — D24: not part of B3.)* pptxgenjs first (DeckCraft is unverified);
  template/brand; LibreOffice for PDF/PNG is an explicit opt-out with the consequence stated.
- [x] **B3-T4 — Checks.** Slide count, overflow, contrast, links, notes, branch/hotspot validity, per-slide snapshots,
  VLM review, plus a **browser-backed acceptance test** that fails on console errors or a blank slide.
  - *Reality:* the engine has **no anchor rule** — `<a href="missing.html">` produces no finding anywhere — so the "links"
    check is about unresolved **targets** (`missing_local_asset`, `audio_src_not_found`, `missing_stylesheet_asset`) and a
    pinning test says so; a future engine that learns links will fail that test, which is the reminder to widen it. Lint
    warns `missing_data_no_timeline` on every scene of a correct deck, so rules filter by code, never by counts.
    `snapshot --at` always appends an end frame, so `deckSnapshot` gained `end: false` (one frame per slide).
    `blankFrame`'s 99.5 % floor called real text slides blank (99.0–99.6 % one colour), so the deck passes 99.9 %.
    `deck.vlm` is skipped with the D13/D21 reason; no cloud model is called.
  - *Reality:* the **coredumps were Chrome's own sandbox**, not our mount list: inside bubblewrap Chrome cannot build a
    second sandbox and dies with `FATAL: No usable sandbox!` — one SIGTRAP per browser session. HyperFrames normally
    detects a container by `/.dockerenv` and passes `--no-sandbox` itself; bwrap leaves no marker. Its documented switch
    `HYPERFRAMES_CHROME_SANDBOX=0` fixes it (measured: two dumps before, none after, with the browser really running), and
    the runner therefore gained the other half: an adapter may **declare env names** and a run may hand their **values**,
    so the deck says "you are in the sandbox" without a global environment variable. `--no-browser-gpu` stays for the
    determinism it gives on its own.
- [ ] **B3-T5 — PPTX checks.** *(deferred — D24: not part of B3.)* Text overflow, fonts, notes, image resolution.
- [x] **B3-T6 — Assets: placeholders only.** No ComfyUI, no Manim — they land later (B5, B2c). A missing asset slot
  renders a labelled placeholder that a check accepts.
  - *Reality:* the placeholder is one dashed box with `data-deck-placeholder="<path>"` and the text `missing asset:
    <path>`; the reason (`missing`, `not a file`, `too large`) lives in `placeholders`/`placeholderNote`, so the check can
    accept it and still name it. A symlink out of the job is refused before anything is written. Hidden slides now write
    their asset too (they are in the HTML, just not scenes). The first monospace stack was rejected by the real
    `hyperframes check` (unknown font family), so the box inherits the deck's sans stack.
- [x] **B3-T7 — Tests.** Spec; slideshow manifest; checks; the blank-slide failure; placeholder rendering. (The PPTX
  smoke is gone with D24.)
  - *Reality:* the audit found a contradiction in the harness, not in the test: `deck.vlm` was a **required** check the
    adapter always skips (D13/D21), and the quality gate refuses every skip below L3 — so no deck could ever ship. A check
    may now be `skippable` in its definition: its skip is a warning the report names, while any other skip still blocks.
    `deck.contract` left the adapter's registry (it is the parse's L0, produced by the gate), so the adapter answers only
    for what it runs. The acceptance test is the whole chain in one place: fixture `plan.md` → spec → adapter through
    `hostRunnerFor` → `check`/`snapshot` → `evaluate` → quality gate → provenance round-trip → `present` fetched over
    HTTP and cancelled. Sensitivity verified by breaking `--no-browser-gpu` and an island scene id and watching the test
    fail. "No GPU" is proven by the argv; the engine's `_meta` names no renderer. Notes come from the author: `plan.md`
    has no notes column, so the handoff cannot supply them and the acceptance test writes them, saying so.

**Files:** `packages/artifact/src/adapters/deck.ts`, `skills/deck/`, `skills.ts` (one registration line),
`test/deck.test.ts`. `pptx.ts` moves with D24.

**Checks:** `npm run typecheck`, `npm test`; a 5-slide deck; present smoke.

**Acceptance:** brief → deck → snapshot checks → present, with no `artifactd`, no GPU and no other adapter built.

**Risks:** HyperFrames' slideshow manifest is the only thing that turns slides into a real deck; if `present` needs a
desktop, the demo path has to change. The HTML deck is the deliverable (D24); PPTX differences are no longer a B3 risk.

---

### B5 — Images + ComfyUI client

**Goal:** The shared ComfyUI client (used by B2b) plus the image adapter, with territory enforcement that works on real
files.

**Tasks**

- [x] **B5-T1 — Image spec.** `images.json`: slots, prompts, model, seed, size, refs, negative.
  - *Reality:* images is version 2 on its own: a `model` on the set and on a slot (name, file, sha256), so a set can name the checkpoint a hash policy will judge.
- [x] **B5-T2 — ComfyUI client (shared).** `/prompt`, `/history`, `/view`, `/ws`, `/object_info`, `/upload/image`;
  local or remote; used by B2b.
  - *Reality:* the client answers every call with a value, never a throw; `/ws` carries progress and `/history` decides completion, so a dropped socket loses nothing and polling is the same path. A remote server must be declared in code (`allowRemote`), never in a spec. One graph per slot, because prompt, size and seed are per slot.
- [x] **B5-T3 — Cloud API optional.** Keys; budget; terms.
  - *Reality:* implemented as an honest **refusal**: the egress gate lives in the plugin, the artifact package may not import it, and a second gate would be a second answer to whether a payload may leave. `cloudImageBackend` names the missing gate, budget ledger and terms instead of calling anything.
- [x] **B5-T4 — Model/license registry + unknown-hash policy.** Wan 2.2, Mochi, CogVideoX, FLUX schnell, Qwen-Image,
  SDXL. Enforcement in the adapter, resolved **by file hash**:
  - hash on the blocklist ⇒ refuse;
  - hash known and allowed ⇒ proceed;
  - **hash unknown ⇒ refuse and ask**, offering to register it with its license and territory — never a silent allow.
  A workflow can load any checkpoint on disk, so a declared name proves nothing.
  Per-variant SPDX: CogVideoX weights are not simply Apache-2.0 (verify).
  - *Reality:* the registry is seeded with the six named models and the published hashes; CogVideoX-5B is recorded as `LicenseRef-CogVideoX` because its LICENSE is not Apache-2.0 (commercial use needs registration with the licensor). Claims that could not be checked on this machine are marked with what was read, not asserted. A declared-but-unknown, blocked or territory-refused checkpoint still refuses; only "no model declared" becomes a placeholder.
- [x] **B5-T5 — VLM checks.** Prompt checklist, style consistency, provenance; placeholders when no model.
  - *Reality:* the deterministic parts run — prompt words reach the workflow, colours are compared across slots, the resolved checkpoint/licence/territory is on the record — and the vision review is `skippable` with the D13/D21 reason. A set without a checkpoint renders labelled placeholder PNGs (checkerboard, no text: a bitmap font would be a second thing to be wrong about), the `images.placeholder` check names them, and the gate ships them as a warning.
- [x] **B5-T6 — GPU contention.** One render at a time via the host runner; `artifactd`'s lock arrives in B6.
  - *Reality:* the adapter runs no program (socket only), so it holds its own single render slot and the runner's `another run is active` rule is asserted against a real runner; the cross-process lock is B6's.
- [x] **B5-T7 — Tests.** Fake ComfyUI; manifest; VLM fixtures; blocklisted hash refused; **unknown hash refused**;
  registration flow; placeholder path.


  - *Reality:* the audit ran the whole chain over the fake server: plan → spec → render → manifest → checks → gate `ship`, and the unknown-hash variant refuses with zero requests. It also named the placeholder gap, which the last change closed; the VLM fixtures the plan asks for have no model to run, so the skip is what is proven.**Files:** `packages/artifact/src/adapters/{comfyui,image}.ts`, `skills/image/`, `test/image.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; one image if models exist; dry-run otherwise.

**Acceptance:** images work when a model exists, placeholders otherwise, and an unknown or EU-excluded checkpoint is
refused rather than silently used.

---

### B2 — Motion MVP (HyperFrames)

**Goal:** Motion video with titles and captions, on the task/check model, with a QA loop. No generative model, no 3D,
no narration.

**Tasks**

- [x] **B2-T1 — HyperFrames adapter.** `preview`, `render`, `present`, `snapshot`, `check`, `lint`; Studio/browser
  open action; never render decks.
  - *Reality:* the engine's runtime moved into `adapters/hyperframes.ts` and both adapters share it; the video adapter renders, snapshots, checks, lints and previews, and its preview needs `--foreground --force-new` or `cancel` leaves a detached server holding the port. `open` cannot open a desktop app headless and reports that need instead of pretending. Size comes from the composition root (the CLI has only preset resolutions), fps/format/quality are argv, and the deck can never reach `render` (argv plus a type guard).
- [x] **B2-T2 — Video spec.** `video.json`: scenes, duration, fps, engine, audio, checks, output.
  - *Reality:* video is version 2 on its own, with `engine`, `audio`, `output` and per-scene `acceptance`; a v1 video is refused by number.
- [x] **B2-T3 — Storyboard/script.** Beat sheet + script + shot list; acceptance per scene.
  - *Reality:* the storyboard is a markdown table a human can edit, parsed strictly; the handoff now goes plan → storyboard → scenes, so a plan's scenes gain acceptance and the 5 s default has one home.
- [x] **B2-T4 — QA.** ffprobe, black/freeze/flash detection, silence, transcript, frame sampling, VLM; 3-round fix
  loop; only safe auto-fixes.
  - *Reality:* QA reads the encoded file, not the browser: ffprobe for stream/format, ffmpeg for ten frames and a silence pass. A freeze is an identical frame **across a cut**, not any repeated frame, or every static title card would fail. Black is luminance ≤ 8 because this writer's ground is 16. Silence, transcript and VLM are `skippable` (no narration, no local model, D13/D21). The fix loop applies only extend/shift/gain within caps, never a wording change, and stops after three rounds.
- [x] **B2-T5 — Tests.** Schema; adapter invocation; QA fixtures; deck-render guard.


  - *Reality:* the audit found a real defect and fixed it: a scene's clip was written as an `<img>`, which the engine would encode as a broken image; it is now a `<video muted autoplay loop playsinline>`, with a test and the clip/picture split. The motion path is scanned for generative endpoints and has none.**Files:** `packages/artifact/src/adapters/{hyperframes,video}.ts`, `skills/video/`, `test/video.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; render a 5 s demo; ffprobe/QA.

**Acceptance:** brief → storyboard → scenes → render → QA → fix → final, without any generative model.

---

### B2b — Generative video (Wan 2.2)

**Goal:** The generative path D4 promises, gated on licence and territory.

**Depends on:** B1, B2 (spec + QA), B5-T2 (ComfyUI client).

**Tasks**

- [ ] **B2b-T1 — Wan 2.2 workflows.** T2V/I2V on A14B (48 GB) and TI2V-5B (24 GB); Mochi 1 / CogVideoX as
  alternatives; local or remote ComfyUI.
- [ ] **B2b-T2 — Licence before run.** Checkpoint resolved by hash, territory checked **before** the workflow starts
  (B5-T4). **Not** MiniMax H3, **not** HunyuanVideo.
- [ ] **B2b-T3 — Provenance.** Seed, model, version, licence, input hashes per clip; variance accepted, no
  reproducibility claim.
- [ ] **B2b-T4 — Tests.** Fake ComfyUI video run; a blocked checkpoint refused; a job whose model is missing degrades to
  B2's motion path with a stated reason.

**Files:** `packages/artifact/src/adapters/{wan,comfyui}.ts`, `test/wan.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; one generated clip if a GPU and a model exist.

**Acceptance:** one real generated clip, and the same job runs on a machine without a GPU by falling back to motion.

---

### B2c — Manim, Blender, audio

**Goal:** Optional enrichment, each independently acceptable.

**Tasks**

- [ ] **B2c-T1 — Manim.** PNG/MP4/WebM; transparent where possible; checks; skip cleanly when LaTeX is absent.
- [ ] **B2c-T2 — Blender.** Headless `-b`; `scene.json`; passes (depth/normal/segmentation); licence external.
- [ ] **B2c-T3 — Audio.** Kokoro/HeyGen optional; music/sfx licence; loudness target.
- [ ] **B2c-T4 — Tests.** Each adapter skipped or run; licence fields recorded.

**Files:** `packages/artifact/src/adapters/{manim,blender,audio}.ts`, `test/{manim,blender}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`.

**Acceptance:** any subset can be absent and the video still completes.

---

### B4 — Web adapter

**Goal:** Website pipeline with real browser checks.

**Tasks**

- [x] **B4-T1 — Site spec.** `site.json`: pages, routes, brand, assets, checks.
- [x] **B4-T2 — One build contract.** Static first; Next/Astro are later adapters, not three code paths.
- [x] **B4-T3 — Checks.** Build, typecheck, lint, unit, Playwright at 3 viewports, axe, Lighthouse, links, console,
  bundle size.
- [ ] **B4-T4 — Visual QA.** Screenshots; VLM rubric; visual diff.
- [x] **B4-T5 — Tests.** Fixture site; checks; screenshots.

**Files:** `packages/artifact/src/adapters/web.ts`, `skills/web/`, `test/web.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; demo site; Lighthouse/axe.

**Acceptance:** a site job builds, checks and previews locally. Publishing is out of scope (D3).

*Done 2026-11-21 (T1–T3, T5; T4 in part):* `SiteSpec` version 2 with `root`, `build {script, out}`, `budget.kb`, `brand`.
`adapters/web.ts` builds with `npm run <script>` and checks with a browser probe (`web-probe.mjs`, copied into the job
and run with `node` by the host runner, under bubblewrap without network): pages, links, build, load, console,
requests, overflow at 390/768/1280 px, axe (serious/critical fail), page weight, screenshots, blank screenshots.
Lighthouse stays out (the user's decision, 2026-11-21); axe-core 4.14.0 (MPL-2.0) is a dependency of
`@omacode/artifact`. Not done from T4: the VLM rubric and the visual diff between rounds. Found on the way: Chromium's
singleton socket under a long job path exceeds the 107-byte limit, so the probe gives it a short TMPDIR in /dev/shm.
Open: if the plugin's node_modules lie in a directory the runner hides (DENY_READ names `~/.config/opencode`), the
probe cannot load Playwright and every browser check fails with that message; where `opencode plugin add` installs
is to be checked in A6.

---

### B6 — `artifactd`

**Goal:** A host daemon, only once a GPU render exists to justify it.

**Tasks**

- [ ] **B6-T1 — Topology.** Local GPU or a remote box? Decide before writing a queue: local daemon with a device lock,
  or a client that dispatches to a remote runner.
- [ ] **B6-T2 — Queue.** Job dirs, logs, `.artifact-status.json`, cancel, retry, one heavy job at a time.
- [ ] **B6-T3 — Lock or dispatch.** Exclusive lock per device, or remote submission with auth; unload/queue policy.
- [ ] **B6-T4 — Content-hash cache.** Reuse renders by hash; invalidate on spec/model change. (§6's cache promise is
  fulfilled here; before B6, adapters run cacheless.)
- [ ] **B6-T5 — Budget.** Wall-clock and render-cost caps per job, enforced, with a stop reason.
- [ ] **B6-T6 — Extend the host runner's safety.** Socket auth; input validation (paths inside job dirs, no arbitrary
  network); specs are worker-authored. B1-T5 already restricts executables, argv and environment — this adds the
  service boundary, it does not replace it.
- [ ] **B6-T7 — Services.** systemd/launchd units; doctor integration.
- [ ] **B6-T8 — Tests.** Queue ordering; cancel mid-render; retry; cache hit; budget stop; rejected spec path.

**Files:** `packages/artifactd/`, `test/artifactd.test.ts`.

**Checks:** `npm run typecheck`, `npm test`; smoke render through the daemon.

**Acceptance:** a job submits, runs, cancels, retries and reports; a bad spec is refused.

**Risks:** a daemon with filesystem and GPU access driven by worker-authored specs is an attack surface — B6-T6 is not
optional.

---

### C1 — Rulebook TUI panel

**Goal:** Edit models, routing, guard questions and test the guard from a TUI panel. **Depends on A2** (question set,
mode names) and A6.

**Tasks**

- [ ] **C1-T1 — Model.** `rulebook.jsonc` schema; validation; versioning; merge with config; version bump when
  questions change (A2-T4).
- [ ] **C1-T2 — Panel.** Tabs: Models, Routing, Guard, Questions, Test.
- [ ] **C1-T3 — Models.** Local/cloud badges; probe; mark local; sensitive route; reflect `local|cloud` only.
- [ ] **C1-T4 — Questions.** Add/edit/delete/enable; type; instructions; criteria; threshold; action; nodes; warnings.
- [ ] **C1-T5 — Test console.** Redacted preview; scores; decision; route; why; save as test case.
- [ ] **C1-T6 — Persistence.** Write `rulebook.jsonc`; reload control file; conflict detection; **validation warnings**
  when a threshold edit would invalidate calibration.
- [ ] **C1-T7 — Build artifacts.** `packages/tui/src/tui.js` is committed and `test/tui-build.test.ts` fails on drift.
  Extend the drift test to **every package with a committed build artifact**, and run `npm run build:tui` in C1 and C2.
- [ ] **C1-T8 — Tests.** Pure functions; validation; TUI smoke.

**Files:** `packages/tui/src/{rulebook.ts,tui.tsx,tui.js}`, `packages/micromanager/src/rulebook.ts`,
`test/{rulebook,tui-build}.test.ts`.

**Checks:** `npm run typecheck`, `npm test`, `npm run build:tui`; manual TUI.

**Acceptance:** the rulebook is editable without hand-editing JSON; the test console shows redaction and routing.

---

### C2 — UI polish, worker steer input, first run

**Goal:** Usable for non-technical users, from install to first deck.

**Tasks**

- [ ] **C2-T1 — Job header.** Goal, phase, progress, cost/time, actions, **and the ask-rate** when `local` is running
  below the A2b gate.
- [ ] **C2-T2 — Settings panel.** All config keys; overrides; reset.
- [ ] **C2-T3 — Worker steer input.** **Spike first**: `session.composer.top` + `<input>`, the server-ack path and a
  file-backed steer control. Then: write the steer file, ack, disable when the worker ended.
- [ ] **C2-T4 — Visual polish.** Theme tokens, spacing, empty states, key hints.
- [ ] **C2-T5 — Build.** `npm run build:tui`; commit `tui.js`.
- [ ] **C2-T6 — Tests.** Pure formatting; the spike's fallback; manual.
- [ ] **C2-T7 — First run.** From "installed" to "first successful deck": a sample brief, one click, the deck opens,
  and a short explanation of what just happened. This is the only job that validates the product end to end.
  *Status 2026-11-24:* deck path done and walked live in the TUI: `/first-deck` (and a one-time offer on the first
  start) → three sample briefs → a build-agent session in `~/.local/share/omacode/first-deck/<brief>` writes, checks
  (`make_artifact`, incl. the new `deck.present` presenter probe) and presents the deck, then explains it in plain
  words (about 3 min on DeepSeek V4.1 Flash). Open: steering a worker without git jargon and a visible ask rate, and
  the walkthrough on a clean machine (with A6).

**Files:** `packages/tui/src/{tui.tsx,settings.ts,steer.ts,firstrun.ts,tui.js}`, `packages/micromanager/src/native.ts`,
`test/tui.test.ts`.

**Checks:** `npm run typecheck`, `npm test`, `npm run build:tui`; manual walkthrough on a clean machine.

**Acceptance:** a non-technical user can install, produce a deck and steer a worker without git jargon — and the ask
rate is visible, not hidden.

---

## 6. Cross-cutting rules

### Plan mode

- No project writes; plan worktree only, populated by copy with exclusions in no-git mode.
- No integration branch; no merge; `merge_job` not installed.
- Artifacts promoted with `lstat`, `realpath`, nested-symlink rejection and a secret scan.
- **Fail closed:** no sandbox ⇒ reader-only, stated in the job status and in `plan.md`.
- **Checks run in the sandbox or are skipped** — never `sh -c` on the plugin host.
- Build reads `plan.md`.

### Harness execution paths

Any place where the harness runs text a worker wrote is a boundary:

| Path | Rule | Task |
|---|---|---|
| Worker shell | sandbox, fail-closed | A1-T7 |
| Task checks / gate | sandboxed per worktree; skipped, or — D23 — unsandboxed after the user's recorded confirmation | A1-T12, A1-T14 |
| Adapter render | allowlisted executable, argv only, `cleanEnv` | B1-T5 |
| Merge | backup, policy, user-answered asks, hook-aware | A3 |
| Daemon | socket auth, path validation | B6-T6 |

### Decider

- Exactly two modes; no hybrid; no silent cloud.
- Guards local unless overridden per session; the override is refused for unredactable payloads.
- No NER ⇒ every cloud call is previewed and confirmed.
- Low confidence asks the user; it never escalates to cloud.
- Redaction lives inside the client so no call site can bypass it.
- The cloud client exists only in `cloud` mode and is the label factory.

### Licenses and territory

- Every component recorded with **per-package SPDX**, territory, allowed use and commercial-use-of-output.
- Enforced **at the adapter**: blocklisted hash refused, unknown hash refused and offered for registration.
- External GPL tools (Blender, ComfyUI) never bundled; called as processes/services.
- Per-asset provenance carries the licence and territory it was produced under.

### Privacy

- Deterministic redaction first; preview and confirm; enforced, not advisory.
- No cloud decision for guard questions by default.

### Downloads

- Never download multi-GB models without consent.
- Show size, licence, territory and expected VRAM.
- Cache and resume; verify hashes. Render caching is deferred to B6-T4 and stated as such.

### Tests

- Every job adds unit tests and at least one integration test where git/render/process behaviour matters.
- `npm run typecheck`, `npm test`, `npm run test:all` before merge.
- Real-git tests for worktrees/merge; fake adapters for artifactd; fixture decks/videos/sites.
- A behaviour that cannot be tested must be **measured** (A2b) or **stated** in the acceptance criteria.

### Determinism and provenance

- HyperFrames/Manim/Blender: deterministic with fixed settings.
- ComfyUI/video models: record seed/model/version; accept variance; never claim exact reproducibility.

### Paths

- `<stateDir>` only; no literals; the scan test (A1-T13) enforces it with an allowlist for legacy detectors.
- No in-project symlinks for state.

### Backward compatibility

- Config/state fallbacks for one release. Migration dry-run; defer when jobs run. No silent data loss.

### UI

- `tui.js` is committed; any `tui.tsx` change runs `npm run build:tui`; the drift test covers every package with a
  committed artifact.

---

## 7. Out of scope now

- External code review services (PR-Agent, open-pr, etc.).
- MCP server manager/registry.
- Remotion.
- MiniMax H3, HunyuanVideo, and any EU-excluded model.
- Localhost web UI for the Rulebook.
- Live voice (later, reuse oc-voice).
- Publishing/deploy (later).
- Fine-tuning UI (later; A2b provides the dataset, D1 the training).
- Render caching before B6.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plan mode bypass via shell or interpreter | Sandbox is the barrier; **fail closed**; interpreter tests |
| **Harness executes worker text outside the sandbox** | A1-T12 (checks), B1-T5 (host runner), B6-T6 (daemon) |
| **An unsandboxed run is approved without the user seeing the risk** | D23/A1-T14: the score, its findings and the check lines are in the form; the grant is per job, journaled, and only the user's answer opens it |
| Plan worktree paths not recognised by `decide.ts` | A1-T10; test that inside-tree commands do not ask |
| Symlinked (incl. nested) artifact escapes | `lstat` + `realpath` + `..` rejection + secret scan |
| Cloud decider leaks | Two modes; redaction inside the client; preview enforced; refused when unredactable |
| Local decider asks everything | A2b measures per-node; numeric gate; ask-rate shown at job start |
| Gate never passes / passes by lowering the bar | Thresholds in the plan; `npm run bench` must exist; corpus version pinned; gate test fails |
| autoMerge damages checkout | Backup ref; fast-forward only; persisted lock; user-answered; hook-aware |
| Orchestrator approves its own merge | `hard: true` asks to the user; `rules` ⇒ no merge |
| Migration breaks worktrees | Dry-run; `git worktree repair`; defer while jobs run; no symlink; namespace pre-check |
| `.opencode/omacode` collides with OpenCode's namespace | A5-T1 pre-check can block the rename |
| Shared-file conflicts A1–A5 | Sequential track S; A1-T13 stops new literals from A1 on |
| Artifact platform too broad | Contracts only in B1; deck first; `artifactd` in B6 |
| Remote GPU breaks `artifactd` | Topology decided in B6-T1 |
| ComfyUI/Blender GPL | External processes; never bundled; manifest |
| Model licence/territory | Blocklist by hash; **unknown hash refused**; per-asset provenance |
| Expensive renders | Host runner one at a time; B6 budget caps; cache |
| UI scope creep | Rulebook first; polish later; one panel at a time |

---

## 9. Execution entry point

Three review rounds are done. Round 3 closed with Qwen at **ready to execute** and Luna's three items fixed in §2.8.
Nothing below re-opens a review.

### Start here

1. **A1** — the only job that blocks both tracks. Its internal order is stated in §5 A1; T0, T1, T3a and T7 are the
   ones that can invalidate the design if they turn out differently, so do them first and stop if they do.
2. **A1-T8** — the `plan.md` schema. As soon as it exists, **Track A unblocks**; everything else in A1 can finish in
   parallel with B1.
3. **B1 → B3** — the first real output.

### Definition of done

A job is done when its **acceptance criteria** hold and its **checks** ran, not when the tasks are ticked. Two rules
that follow from the reviews:

- An acceptance criterion must be able to **fail**. "The pipeline runs" is not one; "a hostile check line cannot write
  the project" is.
- A behaviour that cannot be tested must be **measured** (A2b) or **stated** in the acceptance criteria. Nothing is
  assumed to work because it typechecks.

### Where a new finding goes

- A hole in the boundary → the A1 task that owns that path (A1-T6, T7, T12, B1-T5, B6-T6).
- A measurement problem → A2b.
- A licence or territory question → A6-T9 plus the adapter (B5-T4).
- Anything else → the job whose acceptance it breaks, not a new job.

### Round 4, only if

- A1-T10 or A1-T12 turns out to need a different design than assumed (path rules or check execution), **or**
- B1-T5 cannot be constrained enough for B3 to use it safely, **or**
- A5-T1's namespace pre-check blocks `.opencode/omacode` and the rename has to be re-decided.

Otherwise: execute, and review the code, not the plan.

---

## 10. Appendix

### A. Model and license table

SPDX is **per package**. Rows marked *verify* are not yet confirmed; a wrong row propagates into runtime blocking.

| Model/tool | License | Territory | Use |
|---|---|---|---|
| HyperFrames | Apache-2.0 (npm) — mixed per package, *verify* | worldwide | video, slideshow, site motion |
| Manim | MIT | worldwide | math/technical animation |
| Blender | GPL-2.0-or-later | worldwide | external 3D renderer; output yours |
| ComfyUI | GPL-3.0 | worldwide | external image/video service |
| ComfyUI custom nodes | mixed, often non-commercial | *per node pack* | must be recorded |
| Wan 2.2 | Apache-2.0 | worldwide | video generation |
| Mochi 1 | Apache-2.0 | worldwide | video generation |
| CogVideoX | code Apache-2.0; **weights separate, *verify*** | worldwide, *verify* | video generation |
| LTX-Video | own license, *verify* | *verify* | video generation |
| MiniMax H3 | MiniMax H3 Community | **EU/UK/US/KR excluded, *verify text*** | **blocked** |
| HunyuanVideo | Tencent Hunyuan Community | **EU/UK/SK excluded** | **blocked** |
| FLUX.1 schnell | Apache-2.0 | worldwide | image generation |
| FLUX.1 dev | Non-Commercial | worldwide | non-commercial; output restriction propagates |
| Qwen-Image | Apache-2.0 | worldwide | image generation |
| SDXL | OpenRAIL | worldwide | image generation |
| pptxgenjs | MIT | worldwide | PPTX export |
| DeckCraft | MIT/Apache-2.0, *alpha, unverified* | worldwide | optional; not the default |
| LibreOffice | MPL-2.0 | worldwide | PPTX/PDF preview (~600 MB, opt-out) |
| Remotion | Remotion License | worldwide | **rejected** |

### B. Hardware notes

- 48 GB GPU (assume RTX PRO 5000 Blackwell, may be remote): comfortable for Wan 2.2 A14B, Mochi, CogVideoX.
- RTX 3090 24 GB: Wan 2.2 5B comfortable; A14B with FP8/GGUF/offload; no FP8 hardware, use FP16/GGUF.
- MiniMax H3 (33B + 32B encoder): not practical here, and licence blocked.
- HunyuanVideo: hardware would run it; licence blocked in the EU.
- ComfyUI runs one workflow on one GPU; multi-GPU needs xDiT/parallel inference or one instance per GPU.

### C. Glossary

- **Plan worktree:** throwaway git worktree under `<stateDir>/plan/<job>/worktrees/<task>`; no merge.
- **Promote:** copy declared investigation artifacts into the durable plan dir after `lstat`, `realpath` and a secret scan.
- **Host runner:** allowlisted, argv-only executor for tools that cannot run inside the worker sandbox (B1-T5).
- **artifactd:** host daemon with queue, GPU lock or remote dispatch, cache and budget (B6).
- **Rulebook:** versioned policy/config for models, routing, guard questions and tests.
- **Guard-local:** `injection`, `harmful`, `sensitive` always run on the local backend unless overridden per session.
- **Ask-rate:** the share of decisions that fall below the confidence floor and reach the user (A2b).
- **Reader-only plan job:** a plan job started without a sandbox; no writers or investigators, stated in the status and
  in `plan.md`.
- **Territory:** licence region; EU-excluded models are blocked in setup **and** in the adapter.
