# Omacode in a container — plan

**Goal:** friends and colleagues install Omacode with one script, run it in a container that sees only the directories
they hand it, keep their own keys and changes in a home directory of their own, and get coding, websites and videos
(HyperFrames + Manim) without installing anything else. Linux (Apptainer or rootless Podman) and macOS (Podman).

This plan replaces most of roadmap job **A6** (setup assistant): the image fixes what A6 would have detected, so only
the questions about the user remain (identity, keys, providers, GPU services).

## Decisions

| # | Decision |
|---|---|
| K1 | **One OCI image** built from a `Dockerfile` in this repository, published to `ghcr.io` for `amd64` and `arm64`. Apptainer converts it (`apptainer pull docker://…`); Podman runs it as is. One image, no `full`/`core` split until its size forces one (K9). |
| K2 | **Runtimes:** Linux uses Apptainer, else rootless Podman. macOS uses Podman (`podman machine`); Docker Desktop/OrbStack only when already installed. **Rootful Docker on Linux is not supported** (the daemon is root, the `docker` group is root). |
| K3 | **The container gets its own `$HOME`:** a host directory, by default `~/.local/share/omacode/home`, mounted as `/home/omacode`. Git identity, a dedicated SSH key, OpenCode config and `auth.json`, the user's skills, plugins and `micromanager.jsonc`, and the memory live there. The worker sandbox's `DENY_READ` (`~/.ssh`, `~/.local/share/opencode`, …) applies to it unchanged. |
| K4 | **Only explicit mounts:** the project directory as `/work`, plus `--mount <path>[:ro]`. Apptainer runs with `--containall --no-mount bind-paths,hostfs,home,cwd,tmp`, so site-configured bind paths (NFS shares) are not mounted. |
| K5 | **Two sandboxes:** the container is the outer boundary (what OpenCode itself can see); sandbox-runtime/bubblewrap inside it stays the boundary of every worker command and of the host runner. If bubblewrap cannot run, D23 applies unchanged (the user confirms per job, fail-closed otherwise). |
| K6 | **No fixed open ports.** The decider, the embedding service and OpenCode's server listen on random loopback ports with a bearer token from the container's runtime directory. Apptainer shares the host network, so on a shared machine a fixed port would be reachable by every user. |
| K7 | **Keys belong to each user** and never enter the image: `opencode auth login` inside the container writes them to the container home. |
| K8 | **GWDG SAIA is an opt-in provider** (first-run question "Academic Cloud account?"), with a concurrency cap, models read from `/models`, a neutral name and a "not affiliated" note. |
| K9 | Image size budget: **≤ 4 GB compressed**. Above it, the video stack (TeX, Manim) moves to a second tag. |
| K10 | **Previews go through one gateway** (P0-T5). Under Podman the gateway binds `0.0.0.0` inside the container and the launcher publishes its ports to the host's `127.0.0.1` only; under Apptainer it binds `127.0.0.1`. Every gateway URL carries a token, because on a shared machine the host's loopback is reachable by every user. OpenCode's server is not published by default (the TUI runs inside the container); `omacode --web` publishes it, protected by its own password. |

## Inside and outside

Almost everything is inside. Outside stays only what the host must provide, what holds the user's data, and what
needs a GPU and large models.

| Where | What | Why |
|---|---|---|
| **Host** | Container runtime (Apptainer / Podman) | Has to exist before anything runs. |
| **Host** | The `omacode` launcher script | Picks the runtime, sets the mounts and security flags. |
| **Host** | Container home `~/.local/share/omacode/home` | Keys, config, memory, model caches; survives image updates. |
| **Host** | The project directories the user mounts | The user's data; never copied into the image. |
| **Host** | The browser that opens previews and comparison pages | The launcher prints the URL (loopback + token); the container has no desktop. |
| **Host (optional)** | **ComfyUI**, local LLMs (llama-swap, Ollama) | GPU, multi-GB models, often shared by several users; on macOS a Linux VM cannot reach the Apple GPU, so ComfyUI runs natively there. Reached by URL (`allowRemote` is already in the client). |
| **Image** | OpenCode (pinned), Node, all `@omacode/*` packages (pinned) | The product. |
| **Image** | git, bubblewrap, socat, ripgrep, sandbox-runtime | Worktrees and the worker sandbox. |
| **Image** | Decider (Python env, CPU torch), started by the entrypoint | Guards, redaction, permissions must not be "not running". |
| **Image** | llama.cpp server (CPU) for Qwen3-Embedding-0.6B | Memory search stays local. Weights download on first start into the container home. |
| **Image** | Chromium (Playwright), ffmpeg/ffprobe, HyperFrames | Websites, `look`, the `playwright` tool, decks, video. |
| **Image** | Manim + a minimal TeX Live (LaTeX, dvisvgm, fonts) | Math animation (P4). |
| **Image** | uv and the evolver's environment | `evolve_task` without a first-run download. |
| **Image** | Default config in `/etc/omacode/` | The lowest config layer (P3). |
| **Not in the image** | Model weights (decider checkpoint, embeddings) | Size and licences; downloaded on first start, hash-checked. An offline variant can bake them in later. |
| **Not in the image** | Training (fine-tunes) | Development work, not runtime. |

GPU inside the container is optional (`--nv` for Apptainer, CDI for Podman). Nothing in the default flow needs one.

## Jobs

### P0 — Spikes (decide K2 and K5 before building)

- [x] **P0-T1** sandbox-runtime + bubblewrap inside **rootless Podman** on Linux. No `--privileged`, no
  `seccomp=unconfined`. Done 2026-11-18: works with Podman's **default** seccomp profile plus
  `--security-opt unmask=/proc/*`; no custom profile is needed (see Findings).
- **P0-T2** (macOS, `podman machine`) and **P0-T3** (Apptainer in setuid mode on an institute machine) are no
  longer spikes: they move to **P2-T8** as acceptance runs of `omacode doctor` once image and launcher exist. Neither
  blocks the build: `podman machine` is a Linux VM running the same rootless Podman as P0-T1, and whether bubblewrap
  runs under a site's setuid Apptainer depends on that site's kernel settings, which the plugin cannot change; the
  fallback for both is D23 with the container risk score (P3-T10).
- [x] **P0-T4** Chromium/Playwright and `hyperframes render` under the host runner inside the container (the host
  runner's bubblewrap with the network unshared). Done 2026-11-18 in rootless Podman (see Findings).
- [x] **P0-T5** Reaching OpenCode's server and a preview from the host browser under Apptainer (shared network) and
  Podman (`-p 127.0.0.1:…`). Done 2026-11-18: reachable under both, but differently; it needs a preview gateway
  (K10, P3-T3a; see Findings).

**Acceptance:** for each runtime a written yes/no with the exact flags; findings go to this file.

**Findings**

- **2026-11-18, Apptainer 1.5.3, user-namespace mode (no `starter-suid`), Arch Linux: yes.** The plugin's own
  sandbox (`startSandbox` + `rulesFor` from `packages/sandbox/src/sandbox.ts`, sandbox-runtime 0.0.81) runs inside the
  container. A writer for `/work` wrote its worktree; writing the container home was refused (read-only); the SSH key
  and OpenCode's `auth.json` in the container home were invisible; `registry.npmjs.org` answered 200 through the
  proxy; `example.com` was refused by the proxy (403). Flags:
  `apptainer exec --containall --no-mount bind-paths,tmp,cwd --home <container-home>:/home/omacode --bind /dev/full:/dev/full --bind <tmp>:/tmp …`
  Three things the image and launcher must provide:
  - **`/dev/full`:** `--containall` gives a minimal `/dev` without it, and bubblewrap's `--dev` fails with
    "Can't open source /dev/full". Bind it (or the needed device nodes) explicitly.
  - **A writable `/tmp`:** with `tmp` not mounted, `tempDirFor` cannot create the workers' temp directories. The
    launcher binds a per-instance directory as `/tmp`.
  - **A working resolver:** on hosts where `/etc/resolv.conf` points into `/run/systemd/resolve/`, that target must be
    visible, or every name lookup fails (and the proxy with it). The image ships its own `/etc/resolv.conf` handling;
    the launcher checks DNS in `doctor`.
- **2026-11-18, rootless Podman 6.1.4 (runc), Arch Linux: yes**, with the same six checks passing (worktree write
  allowed; container home read-only; SSH key and `auth.json` invisible; registry 200; `example.com` refused 403).
  Flags: `podman run --rm --userns=keep-id --security-opt unmask=/proc/* -v <container-home>:/home/omacode
  -v <project>:/work -v <tmp>:/tmp …`.
  - **Default seccomp is enough.** Inside the container `Seccomp: 2` with one filter (Podman's
    `/usr/share/containers/seccomp.json`), `CapEff` 0, and bubblewrap still creates its namespaces. The custom
    seccomp profile planned for P0-T1 is not needed.
  - **What fails without the unmask:** `bwrap: Can't mount proc on /proc: Operation not permitted`. Podman covers
    parts of `/proc` (`/proc/kcore`, `/proc/keys`, …) with masks, and the kernel refuses a fresh proc mount while
    the parent's `/proc` is partly hidden. `unmask=/proc/*` lifts only the `/proc` masks (not `/sys`); in the
    rootless user namespace `/proc/kcore` stays unreadable and `/proc/keys` shows only the user's own keyrings.
  - Podman's default `/dev` already has `/dev/full`; no extra device bind as under Apptainer.
- **2026-11-18, renders and browsers in rootless Podman (same flags): yes.** `test/video.test.ts`,
  `test/deck.test.ts`, `test/look.test.ts` and `test/browser.test.ts` with `MM_BROWSER_TESTS=1` ran inside the
  container: **86 tests, 86 passed, 0 skipped** (on the host: the same files, all passing). The runs are real, not
  skips: the full video loop (brief → storyboard → render → QA → fix, 18 s), an MP4 rendered and measured by ffprobe,
  deck snapshots and checks, Playwright clicking, filling and recording. HyperFrames 0.9.54 with its
  `chrome-headless-shell`, system Chromium, ffmpeg. The host runner refuses to run unwrapped when the network is not
  declared, so its bubblewrap with the network unshared works inside Podman as well. HyperFrames' Chrome runs with
  `HYPERFRAMES_CHROME_SANDBOX=0` (already set by the adapter, `hyperframes.ts`); `--no-browser-gpu` keeps it on
  SwiftShader, so the image needs no GPU for renders.
  For the image: HyperFrames and its `chrome-headless-shell` cache under the container home's `.cache/hyperframes`
  (or baked into the image and linked there), Chromium for Playwright, ffmpeg/ffprobe.
- **2026-11-18, servers and the host browser (OpenCode 2.2.5, a loopback and an all-interfaces test server):**

  | Bound inside the container to | rootless Podman, `-p 127.0.0.1:H:C` (pasta) | Apptainer (host network) |
  |---|---|---|
  | `127.0.0.1` | **not reachable** from the host | reachable on the host's loopback, by **every local user** |
  | `0.0.0.0` | reachable on the host's `127.0.0.1:H` only | reachable from the **LAN** (checked from the host's LAN address) |

  - Podman forwards a published port to the container's interface, not to its loopback; the plugin's servers
    (`look`, the presenter, the HyperFrames preview, the evolver) all bind `127.0.0.1` on a random port
    (`freePort`), so today none of them is reachable from the host browser under Podman, and a random port cannot be
    published up front anyway.
  - Under Apptainer the same servers are reachable, but by every user of a shared machine; anything bound to
    `0.0.0.0` lands on the LAN. Nothing may bind `0.0.0.0` under Apptainer.
  - OpenCode's server generates a password at start (printed in its log). Without it only the static web UI answers
    (`text/html`); `GET`/`POST /api/session` answer 401. The plugin's own servers have no such protection yet.
- **Consequence (K10):** one preview gateway instead of making every server reachable.
- The proxy runs inside the plugin's Node process: a caller that blocks the event loop (`execSync`) makes every
  allowed request time out. The plugin runs commands asynchronously; tests and scripts must too.

### P1 — Image

- [ ] **P1-T1** Multi-stage `Dockerfile` (Debian slim base): tool layer, Node + OpenCode, `@omacode/*` from npm at the
  release version (a build arg switches to the checkout for dev builds), decider env (`uv sync --frozen`), llama.cpp
  CPU server, Chromium, ffmpeg, HyperFrames, Manim + TeX, evolver env. Non-root user `omacode`.
- [ ] **P1-T2** Entrypoint `omacode-init`: create the runtime directory, generate the token, start a small
  supervisor for decider and embedding (random loopback ports), write their URLs for the plugin, then exec OpenCode.
  A service that fails is reported, not hidden.
- [ ] **P1-T2a** The supervisor runs each service in one of three states, read from a control file in the runtime
  directory: **on** (always running), **auto** (default: started on the first request, stopped after an idle time,
  10 min by default) and **off**. In `auto` the plugin's client waits for the start instead of failing; the state and
  whether the process runs right now are written back for the TUI.
- [ ] **P1-T3** `decider/decider.service` and its hard-coded checkout path go; the decider reads its port, token and
  model from the environment, and answers 401 without the token.
- [ ] **P1-T4** CI: build `amd64` + `arm64`, push to `ghcr.io`, size check against K9, smoke test (`omacode doctor`
  inside the image).
- [ ] **P1-T5** Third-party manifest of the image contents (Chromium, ffmpeg's GPL build, TeX Live, Manim,
  HyperFrames, OpenCode, models), extending A6-T9: SPDX licence per component, where its licence text lives in the
  image, and the models' licences even though they are downloaded, not shipped.
- [ ] **P1-T6** Keep the licence texts in the image: the slim build must not drop `/usr/share/doc/*/copyright`;
  Node and Python packages keep their `LICENSE`/`NOTICE` files (Apache-2.0 requires the NOTICE); `/usr/share/omacode/
  licenses/` collects the rest. The smoke test fails when a manifest entry has no licence text in the image.
- [ ] **P1-T7** GPL/LGPL corresponding source (git, ffmpeg, socat, bash, coreutils, bubblewrap, …): every release
  publishes the exact Debian package list with versions and the `snapshot.debian.org` source links, plus a source
  archive of the GPL/LGPL packages as a release asset (written by CI with `apt-get source`).
- [ ] **P1-T8** Video codecs: the default video output is VP9/AV1 in WebM; H.264/H.265 MP4 stays available on request
  (patent caution, not a licence issue).

**Checks:** `docker build`/`podman build`; smoke test in CI. **Acceptance:** one image runs on both architectures and
passes `omacode doctor`.

### P2 — Launcher

- [ ] **P2-T1** `omacode` (POSIX shell, Linux + macOS), installed by `curl -fsSL …/get-omacode.sh | sh` into
  `~/.local/bin`.
- [ ] **P2-T2** Runtime detection per K2, flags per K4/K5 and the P0 findings: Apptainer binds `/dev/full`, a per-instance `/tmp` and
  the resolver; Podman uses `--userns=keep-id` and `--security-opt unmask=/proc/*` with its default seccomp profile.
- [ ] **P2-T3** First run: create the container home; ask for git name/e-mail; offer a dedicated SSH key; ask for
  providers (own keys via `opencode auth login`, GWDG opt-in per K8); write the default config.
- [ ] **P2-T4** Mounts: `$PWD` → `/work`; refuse `/` and the host `$HOME` as the project; `--mount <path>[:ro]`;
  print what the container will see before the first start of a project.
- [ ] **P2-T5** Commands: `omacode` (start TUI in `$PWD`), `omacode shell`, `omacode doctor`, `omacode update`
  (pull the image), `omacode --dev <checkout>` (mount a checkout over the installed packages), `omacode uninstall`
  (removes image and launcher, says it keeps the home).
- [ ] **P2-T6** Two sessions at once on different projects (separate instances, separate ports). Each instance
  takes its own block of free host ports for the gateway (K10) and hands it in as `OMACODE_GATEWAY_PORTS`; under
  Podman they are published as `-p 127.0.0.1:H:H`, so host and container port are the same number.
- [ ] **P2-T7** Without bubblewrap (K5), the launcher probes it before the first run and changes the first-run
  offer: no SSH key is put into the container home; it recommends HTTPS with a narrowly scoped token instead, and says
  why (without bubblewrap every worker command can read the container home).

- [ ] **P2-T8** Acceptance runs on real machines, with the image from P1 and this launcher; each result goes to
  P0's Findings:
  - **macOS** (arm64, `podman machine`, by a colleague with a Mac): `omacode doctor` passes the sandbox section;
    mounted folders keep the user's ownership with `--userns=keep-id`; a preview opens in the Mac's browser.
  - **Institute machine** with the site's Apptainer (setuid or not, `ls /usr/libexec/apptainer/bin/starter-suid`):
    `omacode doctor` says whether bubblewrap runs. If not, the reduced-protection path (P2-T7, P3-T9..T11) is what
    users there get, and it is checked by hand once.

**Checks:** `shellcheck`; launcher tests with a fake runtime. **Acceptance:** a new user goes from nothing to a TUI in
`/work` with three commands, on Linux and macOS; P2-T8 is written down for both machines.

### P3 — Plugin changes for the container

- [ ] **P3-T1** Config layers: `/etc/omacode/` (image) → `~/.config/opencode/` (container home) →
  `.opencode/omacode/` (project). Skills and plugins from the container home load like the built-in ones.
- [ ] **P3-T2** Decider and embedding URLs and the token from the environment the entrypoint writes; embedding
  default `qwen3-embedding-0.6b` in the container.
- [ ] **P3-T3** `hyperframes open` and other desktop hand-offs print a URL instead when there is no display.
- [ ] **P3-T3a** The preview gateway (K10): a small HTTP forwarder in the plugin that owns a fixed set of ports
  (default 8, from `OMACODE_GATEWAY_PORTS`). Each preview the plugin starts (`look`, presenter, HyperFrames preview,
  comparison pages) gets one gateway port and a token; the gateway forwards HTTP and WebSocket upgrades to the
  preview's internal `127.0.0.1` port unchanged (no path rewriting, so studios with absolute paths keep working), and
  answers 401 without the token (taken once from the URL, then a cookie). The URL the user gets names the host-side
  port. The plugin's servers keep binding `127.0.0.1`; outside the container the gateway is off and nothing changes.
- [ ] **P3-T3b** Tests: forwarding, WebSocket upgrade, token and cookie, a preview that ends frees its port, all
  ports busy is reported.
- [ ] **P3-T4** Provider trust tiers `local` / `institutional` / `cloud` in the guard: per tier, what may be sent and
  whether redaction is required. GWDG is `institutional`, never `local`.
- [ ] **P3-T5** GWDG SAIA provider template (base URL `https://chat-ai.academiccloud.de/v1`, models from `/models`,
  concurrency cap, no paid models by default).
- [ ] **P3-T6** TUI switches `/decider` and `/embedding` (slash and palette, like `/auto` and `/parallel`) cycle
  on → auto → off by writing the supervisor's control file (P1-T2a). The sidebar shows one status line per service
  (`decider: auto · idle`, `embedding: off`); clicking it switches too.
- [ ] **P3-T7** What off means, said where it is switched:
  - **Embedding off:** memory search runs on keywords only (BM25), and says so; missing vectors are filled in when
    the service is back. No warning beyond the status line.
  - **Decider off:** decisions fall back to the `rules` backend. Pattern redaction (secrets, e-mail, phone, IBAN,
    cards) stays; names and addresses are no longer redacted, and the guards and automatic permission answers ask the
    user instead. Switching it off shows this in a toast; while a `cloud`-tier provider is in use it needs a
    confirmation, since names would leave the machine unredacted.
- [ ] **P3-T8** Tests: the three states and the idle stop with a fake service, the client waiting for an `auto`
  start, keyword-only search reported, the confirmation for decider off with a cloud provider.
- [ ] **P3-T9** `doctor` knows the container: runtime, mounts, bubblewrap availability, services, token, image version.
  A missing bubblewrap is reported as **reduced protection**, its own section with what it exposes, not a warning
  line among the others.
- [ ] **P3-T10** D23 in the container: when bubblewrap cannot run, the per-job confirmation stays, but its risk score
  knows it runs inside the container and lists exactly what a worker command can reach: the keys in the container
  home, `/work` including `.git`, every `--mount`, and the network. The environment stays cleaned (`cleanEnv`)
  either way; the form says that files are not covered by it.
- [ ] **P3-T11** A standing `allow` for unsandboxed runs (the existing setting, journaled with the score) is accepted
  only inside the container; on a host without the container it keeps asking per job.
- [ ] **P3-T12** Tests: the container-aware risk score and its reach list, `allow` refused outside the container,
  `doctor`'s reduced-protection section, the launcher's first run without bubblewrap offering no SSH key.

**Checks:** `npm run typecheck`, `npm test`. **Acceptance:** the plugin runs unchanged on a host checkout and in the
container.

### P4 — Manim (B2c-T1, brought forward)

- [ ] **P4-T1** `packages/artifact/src/adapters/manim.ts`: a scene file written by the worker, rendered by `manim`
  through the host runner (allowlisted executable, argv only, network unshared, inside the job directory). Scene code
  is Python a worker wrote, so the network stays cut and nothing outside the job is writable.
- [ ] **P4-T2** Outputs PNG, MP4, WebM; transparent WebM/MOV with `--transparent`; quality and resolution from the
  spec.
- [ ] **P4-T3** A Manim clip as a scene element of a HyperFrames video (the video spec references the rendered file;
  provenance records both).
- [ ] **P4-T4** Checks: ffprobe duration/size/codec, frame sampling through the existing QA pass, LaTeX errors read
  from the log. Outside the container a missing LaTeX skips the adapter with "no math animations".
- [ ] **P4-T5** A `manim` skill for designers and writers: when Manim instead of HyperFrames, scene conventions,
  examples.
- [ ] **P4-T6** Tests: `test/manim.test.ts` (adapter, argv, skip path), one rendered scene in the image smoke test.

**Checks:** `npm run typecheck`, `npm test`. **Acceptance:** "explain the Pythagorean theorem as a short video" yields
an MP4 that combines a Manim clip with HyperFrames titles, checked and with provenance.

### P5 — Publishing

- [ ] **P5-T1** Before the repository goes public: scan the history for secrets (`gitleaks`), remove personal paths
  (`/home/t1dde`, the decider unit), keep `run_logs/` and `.jev-micromanager/` out.
- [ ] **P5-T2** README "Install" becomes the three commands; a "Customize" page: the container home's layout, own
  skills and plugins, a derived image (`FROM ghcr.io/…/omacode` + extra tools), `--dev`.
- [ ] **P5-T3** A "Data" page: what the container sees, what leaves the machine per provider tier, that each institute
  decides on GWDG for its own data.
- [ ] **P5-T4** Tagged release: npm packages and image share one version; the release notes link the licence
  manifest (P1-T5) and the GPL source assets (P1-T7).
- [ ] **P5-T5** Names and marks: the README says "works with Manim, HyperFrames, Blender, GWDG SAIA" without their
  logos or any claim of endorsement; Omacode is described as inspired by Omarchy, not part of it, and uses no Omarchy
  logo.
- [ ] **P5-T6** A licence section in the README: the plugin is Apache-2.0 and calls the tools as separate programs;
  the image redistributes them under their own licences (P1-T5/P1-T7); generated media belong to the user, model
  terms still apply.

## Order

P0 → P1 → P2 → P3 → P5. P4 can start after P0-T4 in parallel with P1-P3; it needs only the host runner and Manim on
the development machine.

## Not in this plan

- Replacing GLiNER with mmBERT (multilingual ModernBERT): its own track. The decider's wire format
  (`/v1/systemone`, `/v1/entities`) stays, so the image only swaps the checkpoint and later moves the decider to ONNX
  Runtime to drop torch.
- ComfyUI in a container of its own, generative video (B2b), Blender and audio (B2c-T2/T3).
- Network egress filtering for the whole container (needs root under Apptainer; the guard covers what is sent).
