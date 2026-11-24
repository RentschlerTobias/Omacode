// @generated from packages/tui/src/tui.tsx by `npm run build:tui` — do not edit.
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
// The micromanager in OpenCode's terminal UI: a CLI plugin. opencode 2.0.18 loads it from cli.json "plugins" as a
// package directory whose package.json exports "./tui" (install.sh writes one that imports this file).
//
// - Above the prompt: one line with the job's progress ("job-… · 7/19 ✔ · 3 ▶ · execute").
// - In the sidebar: the job as a checklist, grouped by what needs attention (src/progress.ts sidebarGroups).
// - /workers: a session panel with every recent session and its workers, as herdr shows agents (src/switcher.ts).
// - /tasks: pick a task to open its worker session, or go back to the micromanager from a worker.
// - Under the job's header: its options as toggles (auto-continue, parallel, review) and STOP, which interrupts the
//   micromanager and every worker of the job at once; /auto, /parallel and /stop do the same (src/control.ts).
// - In the sidebar, below the checklist, and /pools: the models each worker role may run on, picked in a popup like
//   /model (src/pools.ts). The picks go to a file the server reads at each delegation (src/config.ts loadPicks).
// - In the sidebar, SERVICES (folded, below MODELS), and /services: the decider and the embedding service of omacode-services, each on, auto or off, the device it runs on
//   (the embedding service: CPU or a GPU llama.cpp lists), and the idle time after which a service in auto stops (@omacode/core/service-control; the supervisor polls the file it writes).
// - Once on the first start: "what do you want to make?"; the answer decides which parts are offered and installed
//   (@omacode/micromanager/features), decks then lead to the first deck. /setup lists every part and installs one;
//   /first-deck: pick a sample brief and the build agent writes, checks and presents a deck, then explains it (C2-T7).
// - In the sidebar, CONTEXT: the session's context against its ceiling, its workers' contexts, the memory and the notes
//   the last request got from it, from the status files the server writes (src/context/status.ts).
//
// The job file is the source of the checklist: it holds every task and its sessions, also those of a planned job,
// whose workers are not children of the micromanager in OpenCode's eyes. Keymap layers only work inside a rendered
// component (live spike: "Keymap.Provider is missing" from setup), so the commands are registered from the "app" slot.

import { Plugin } from "@opencode/plugin/tui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { loadPicks, loadRouting, savePicks } from "@omacode/state/picks";
import { lastOptions, loadControl, optionsOf, updateControl } from "@omacode/state/control";
import { MICROMANAGER } from "@omacode/state/roles";
import { agentOptions, CLEAR, modelOptions, poolRows, RESET, shortNames, toggle, updatePicks, VISION } from "./pools.ts";
import { BOX, foldedLine, jobsFor, modeOfSession, projectOf, resolver, sessionJobs, sidebarCounts, sidebarGroups, summaryLine, taskChoices, view } from "./progress.ts";
import { listJobs } from "@omacode/state/store";
import { agentRows, agentSummary, taskSessions } from "./switcher.ts";
import { seedFromJournal } from "./usage.ts";
import { BRIEFS, firstDeckDir, firstDeckPrompt, GOALS, hyperframesInstalled, markOffered, prepareFirstDeckDir, wasOffered } from "./firstrun.ts";
import { exec as featuresExec, gpus, installParts, outcomeText, presentState } from "@omacode/micromanager/features";
import { isPresent, OFFER_IDS, OFFERS } from "@omacode/micromanager/setup";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { userStateDir } from "@omacode/core/paths";
import { deviceName, IDLE_CHOICES, MODE_HELP, MODES, serviceLine, servicesView, setIdleMinutes, setServiceDevice, setServiceMode } from "@omacode/core/service-control";
import { bar, foldedContext, kTokens, readMemoryStats, readStatus } from "@omacode/context/status";
const POLL_MS = 2_000;
const PANEL = "micromanager.agents";

// The plugin context as this file uses it; the host's own types are not a dependency of this repository.

// What a host answer holds: the hub wraps lists as { data }.
const items = answer => {
  const d = answer?.data ?? answer;
  return Array.isArray(d) ? d : [];
};
const ids = answer => {
  const d = answer?.data ?? answer;
  if (Array.isArray(d)) return d.map(x => typeof x === "string" ? x : String(x.sessionID ?? x.id));
  return d && typeof d === "object" ? Object.keys(d) : [];
};

// The colors of the checklist marks, from the theme, so light and dark both work.
function palette(context) {
  const t = context.theme;
  const mark = {
    done: t.diff?.text?.added ?? t.text.base,
    failed: t.diff?.text?.removed ?? t.text.base,
    running: t.text.action?.primary?.base ?? t.text.base,
    waiting: t.hue?.orange?.["500"] ?? t.text.base,
    stopped: t.hue?.orange?.["500"] ?? t.text.base,
    dropped: t.text.muted,
    open: t.text.muted
  };
  const tag = {
    RUN: mark.running,
    ASK: mark.waiting,
    IDLE: t.text.muted,
    DONE: mark.done,
    FAIL: mark.failed
  };
  return {
    base: t.text.base,
    muted: t.text.muted,
    mark,
    tag
  };
}
const cut = (text, width) => text.length > width ? `${text.slice(0, width - 1)}…` : text;

// The project of a session: its directory, or the project a worker's worktree lies in.
function projectFor(context, sessionID) {
  const directory = context.data.session.get(sessionID)?.location?.directory;
  return directory ? projectOf(directory) : undefined;
}
function jobsOf(context, sessionID) {
  const directory = context.data.session.get(sessionID)?.location?.directory;
  if (!directory) return [];
  try {
    return listJobs(projectOf(directory));
  } catch {
    return []; // a job file being written right now: the next poll reads it
  }
}
function read(context, sessionID) {
  const jobs = jobsOf(context, sessionID);
  const resolve = resolver(jobs); // a task done over in another job of the session
  return jobsFor(jobs, sessionID).map(job => view(job, Date.now(), resolve));
}

// The session's jobs, kept fresh while the component that asked for them is on screen.
function useJobs(context, sessionID) {
  const [jobs, setJobs] = createSignal(read(context, sessionID()));
  const timer = setInterval(() => setJobs(read(context, sessionID())), POLL_MS);
  onCleanup(() => clearInterval(timer));
  return jobs;
}

// What the given sessions wait for: a pending permission (its action and request id) or an open question.
async function pending(context, sessions) {
  const out = new Map();
  await Promise.all(sessions.map(async sessionID => {
    const first = items(await context.client.permission.list({
      sessionID
    }).catch(() => undefined))[0];
    if (first?.id) out.set(sessionID, {
      what: first.action ?? "permission",
      requestID: first.id
    });
  }));
  for (const form of items(await context.client.form?.list({}).catch(() => undefined))) {
    const sessionID = form.sessionID;
    if (sessionID && sessions.includes(sessionID) && !out.has(sessionID)) out.set(sessionID, {
      what: "a question"
    });
  }
  return out;
}

// The mode above the prompt. The user could not tell plan from build (2026-11-17), so it is always on screen, and it
// is read from the file the plugin writes rather than asked of the model.
function useMode(sessionID) {
  const [mode, setMode] = createSignal(modeOfSession(sessionID()));
  const timer = setInterval(() => setMode(modeOfSession(sessionID())), POLL_MS);
  onCleanup(() => clearInterval(timer));
  return mode;
}
function Progress(props) {
  const jobs = useJobs(props.context, () => props.sessionID);
  const mode = useMode(() => props.sessionID);
  const label = () => mode() === "plan" ? "PLAN · planning only" : "BUILD";
  const shown = () => jobs().filter(j => j.total > 0);
  // The plan/build mode is the micromanager's: a session of another agent with no job shows nothing here (a build
  // session used to read "PLAN · planning only" while it was building).
  const orchestrated = () => props.context.data.session.get(props.sessionID)?.agent === MICROMANAGER.agent;
  return _$createComponent(Show, {
    get when() {
      return shown().length;
    },
    get fallback() {
      return _$createComponent(Show, {
        get when() {
          return orchestrated();
        },
        get children() {
          var _el$ = _$createElement("text"),
            _el$2 = _$createTextNode(`micromanager · `);
          _$insertNode(_el$, _el$2);
          _$insert(_el$, label, null);
          _$effect(_$p => _$setProp(_el$, "fg", props.context.theme.text.muted, _$p));
          return _el$;
        }
      });
    },
    get children() {
      return _$createComponent(For, {
        get each() {
          return shown();
        },
        children: job => (() => {
          var _el$3 = _$createElement("text"),
            _el$4 = _$createTextNode(`micromanager · `),
            _el$5 = _$createTextNode(` · `),
            _el$6 = _$createTextNode(` · /tasks · /workers`);
          _$insertNode(_el$3, _el$4);
          _$insertNode(_el$3, _el$5);
          _$insertNode(_el$3, _el$6);
          _$insert(_el$3, label, _el$5);
          _$insert(_el$3, () => summaryLine(job), _el$6);
          _$effect(_$p => _$setProp(_el$3, "fg", props.context.theme.text.muted, _$p));
          return _el$3;
        })()
      });
    }
  });
}

// The job's switches as the user flips them. STOP interrupts at once from here (the TUI reaches every session), and
// the control file keeps anything from starting or waking until the user lifts it.
async function stopJob(context, project, job) {
  const sure = await context.ui.dialog.confirm({
    title: "Stop the job?",
    message: `Interrupts the micromanager and every worker of ${job.id}. Their work stays and can be continued.`,
    label: "Stop"
  });
  if (!sure) return;
  updateControl(project, job.id, {
    stopped: true,
    auto: false,
    pause: undefined
  });
  const sessions = [job.facilitator, ...job.rows.filter(r => ["running", "gating", "fixing", "reviewing"].includes(r.status) && !r.stopped).map(r => r.session)];
  await Promise.all(sessions.filter(x => Boolean(x)).map(sessionID => context.client.session.interrupt({
    sessionID
  }).catch(() => undefined)));
  context.ui.toast.show({
    message: `Stopped ${job.id}`,
    variant: "success"
  });
}
const flipped = (project, job, key) => {
  const control = loadControl(project, job.id);
  const now = key === "auto" ? control.auto === true : optionsOf(control, lastOptions(project))[key];
  return updateControl(project, job.id, {
    [key]: !now,
    ...(key === "auto" ? {
      pause: undefined,
      wakes: 0
    } : {})
  });
};
function JobControls(props) {
  const colors = palette(props.context);
  const [control, setControl] = createSignal(loadControl(props.project, props.job.id));
  const timer = setInterval(() => setControl(loadControl(props.project, props.job.id)), POLL_MS);
  onCleanup(() => clearInterval(timer));
  const opts = () => optionsOf(control(), lastOptions(props.project));
  const box = on => on ? "☑" : "☐";
  const toggle = key => setControl(flipped(props.project, props.job, key));
  // Whether the job's worker commands run in the sandbox, as the server last wrote it (src/shell/sandbox.ts).
  const sandbox = () => control().sandbox;
  return (() => {
    var _el$7 = _$createElement("box"),
      _el$8 = _$createElement("box");
    _$insertNode(_el$7, _el$8);
    _$setProp(_el$8, "flexDirection", "row");
    _$insert(_el$8, _$createComponent(Show, {
      get when() {
        return control().stopped;
      },
      get fallback() {
        return [(() => {
          var _el$12 = _$createElement("text"),
            _el$13 = _$createTextNode(` `);
          _$insertNode(_el$12, _el$13);
          _$setProp(_el$12, "onMouseUp", () => toggle("auto"));
          _$insert(_el$12, (() => {
            var _c$ = _$memo(() => !!(control().auto && control().pause));
            return () => _c$() ? `auto ⏸ ${control().pause}` : `${box(control().auto === true)} auto`;
          })(), _el$13);
          _$effect(_$p => _$setProp(_el$12, "fg", control().auto ? colors.mark.running : colors.muted, _$p));
          return _el$12;
        })(), (() => {
          var _el$14 = _$createElement("text"),
            _el$15 = _$createTextNode(` parallel `);
          _$insertNode(_el$14, _el$15);
          _$setProp(_el$14, "onMouseUp", () => toggle("parallel"));
          _$insert(_el$14, () => box(opts().parallel), _el$15);
          _$effect(_$p => _$setProp(_el$14, "fg", opts().parallel ? colors.base : colors.muted, _$p));
          return _el$14;
        })(), (() => {
          var _el$16 = _$createElement("text"),
            _el$17 = _$createTextNode(` review`);
          _$insertNode(_el$16, _el$17);
          _$setProp(_el$16, "onMouseUp", () => toggle("review"));
          _$insert(_el$16, () => box(opts().review), _el$17);
          _$effect(_$p => _$setProp(_el$16, "fg", opts().review ? colors.base : colors.muted, _$p));
          return _el$16;
        })(), (() => {
          var _el$18 = _$createElement("box");
          _$setProp(_el$18, "flexGrow", 1);
          return _el$18;
        })(), (() => {
          var _el$19 = _$createElement("text");
          _$insertNode(_el$19, _$createTextNode(`■ STOP`));
          _$setProp(_el$19, "onMouseUp", () => void stopJob(props.context, props.project, props.job).then(() => setControl(loadControl(props.project, props.job.id))));
          _$effect(_$p => _$setProp(_el$19, "fg", colors.mark.failed, _$p));
          return _el$19;
        })()];
      },
      get children() {
        return [(() => {
          var _el$9 = _$createElement("text");
          _$insertNode(_el$9, _$createTextNode(`■ stopped`));
          _$effect(_$p => _$setProp(_el$9, "fg", colors.mark.failed, _$p));
          return _el$9;
        })(), (() => {
          var _el$1 = _$createElement("box");
          _$setProp(_el$1, "flexGrow", 1);
          return _el$1;
        })(), (() => {
          var _el$10 = _$createElement("text");
          _$insertNode(_el$10, _$createTextNode(`resume ▸`));
          _$setProp(_el$10, "onMouseUp", () => setControl(updateControl(props.project, props.job.id, {
            stopped: false
          })));
          _$effect(_$p => _$setProp(_el$10, "fg", colors.base, _$p));
          return _el$10;
        })()];
      }
    }));
    _$insert(_el$7, _$createComponent(Show, {
      get when() {
        return sandbox();
      },
      children: state => state() === "on" ? (() => {
        var _el$21 = _$createElement("text");
        _$insertNode(_el$21, _$createTextNode(`sandbox ✓`));
        _$effect(_$p => _$setProp(_el$21, "fg", colors.muted, _$p));
        return _el$21;
      })() : (() => {
        var _el$23 = _$createElement("text");
        _$insert(_el$23, () => cut(`no sandbox · ${state().replace(/^off: /, "")}`, 36));
        _$effect(_$p => _$setProp(_el$23, "fg", colors.mark.waiting, _$p));
        return _el$23;
      })()
    }), null);
    return _el$7;
  })();
}

// Groups folded at first: DONE and DROPPED always, FAILED only once it is empty (then it is not shown anyway).
const FOLDED_AT_FIRST = ["done", "dropped"];

// One job as a checklist: its header, the counts, and the groups; DONE, FAILED and DROPPED fold on a click.
// One session under an unfolded task (src/switcher.ts taskSessions): what it does, how long, and the context it has
// used. A click opens it; a session the host no longer lists is dimmed and inert.
function SubagentRow(props) {
  const colors = palette(props.context);
  const tag = () => props.row.known ? props.row.tag : "IDLE";
  const open = () => {
    if (props.row.known) props.context.ui.router.navigate({
      type: "session",
      sessionID: props.row.id
    });
  };
  return (() => {
    var _el$24 = _$createElement("box"),
      _el$25 = _$createElement("box"),
      _el$26 = _$createElement("text"),
      _el$27 = _$createElement("text"),
      _el$28 = _$createElement("box");
    _$insertNode(_el$24, _el$25);
    _$insertNode(_el$25, _el$26);
    _$insertNode(_el$25, _el$27);
    _$insertNode(_el$25, _el$28);
    _$setProp(_el$25, "flexDirection", "row");
    _$setProp(_el$25, "paddingLeft", 2);
    _$setProp(_el$25, "onMouseUp", open);
    _$insert(_el$26, () => tag().padEnd(5));
    _$insert(_el$27, () => cut(`${props.row.agent || "worker"} ${props.row.title}`, 21).padEnd(22));
    _$setProp(_el$28, "flexGrow", 1);
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return props.row.elapsed;
      },
      get children() {
        var _el$29 = _$createElement("text");
        _$insert(_el$29, () => props.row.elapsed);
        _$effect(_$p => _$setProp(_el$29, "fg", colors.muted, _$p));
        return _el$29;
      }
    }), null);
    _$insert(_el$24, _$createComponent(SessionContextLine, {
      get context() {
        return props.context;
      },
      get sessionID() {
        return props.row.id;
      }
    }), null);
    _$effect(_p$ => {
      var _v$ = colors.tag[tag()],
        _v$2 = props.row.known ? colors.base : colors.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$26, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$27, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$24;
  })();
}

// The context that session has used, folded to one line: the same bar the CONTEXT section draws, here per session, so
// an unfolded task says at a glance which worker is near its summary.
function SessionContextLine(props) {
  const colors = palette(props.context);
  const [status, setStatus] = createSignal(readStatus(props.sessionID));
  const timer = setInterval(() => setStatus(readStatus(props.sessionID)), POLL_MS);
  onCleanup(() => clearInterval(timer));
  const full = s => s.tokens >= s.summaryAt;
  return _$createComponent(Show, {
    get when() {
      return status();
    },
    children: s => (() => {
      var _el$30 = _$createElement("box"),
        _el$31 = _$createElement("text"),
        _el$32 = _$createElement("text");
      _$insertNode(_el$30, _el$31);
      _$insertNode(_el$30, _el$32);
      _$setProp(_el$30, "flexDirection", "row");
      _$setProp(_el$30, "paddingLeft", 2);
      _$insert(_el$31, () => bar(s().tokens, s().ceiling, s().summaryAt, 10));
      _$insert(_el$32, () => ` ${kTokens(s().tokens)}${full(s()) ? " ⚠" : ""}`);
      _$effect(_p$ => {
        var _v$3 = full(s()) ? colors.mark.waiting : colors.muted,
          _v$4 = colors.muted;
        _v$3 !== _p$.e && (_p$.e = _$setProp(_el$31, "fg", _v$3, _p$.e));
        _v$4 !== _p$.t && (_p$.t = _$setProp(_el$32, "fg", _v$4, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$30;
    })()
  });
}
function JobChecklist(props) {
  const colors = palette(props.context);
  const [folded, setFolded] = createSignal(new Set(FOLDED_AT_FIRST));
  const toggle = key => setFolded(was => {
    const next = new Set(was);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  // The tasks whose sessions are unfolded, by job and task: two job cards never share one.
  const [grown, setGrown] = createSignal(new Set());
  const grow = key => setGrown(was => {
    const next = new Set(was);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const groups = () => sidebarGroups(props.job, props.waiting);
  const foldable = key => key === "done" || key === "failed" || key === "dropped";
  return (() => {
    var _el$33 = _$createElement("box"),
      _el$34 = _$createElement("box"),
      _el$35 = _$createElement("text"),
      _el$36 = _$createElement("box"),
      _el$37 = _$createElement("text"),
      _el$40 = _$createElement("box"),
      _el$41 = _$createElement("box"),
      _el$42 = _$createElement("text"),
      _el$43 = _$createTextNode(`/`);
    _$insertNode(_el$33, _el$34);
    _$insertNode(_el$33, _el$40);
    _$insertNode(_el$34, _el$35);
    _$insertNode(_el$34, _el$36);
    _$insertNode(_el$34, _el$37);
    _$setProp(_el$34, "flexDirection", "row");
    _$insert(_el$35, () => cut(props.job.title, 26));
    _$setProp(_el$36, "flexGrow", 1);
    _$insert(_el$37, () => props.job.phase);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.own)() && props.project;
      },
      children: project => _$createComponent(JobControls, {
        get context() {
          return props.context;
        },
        get project() {
          return project();
        },
        get job() {
          return props.job;
        }
      })
    }), _el$40);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return props.job.isolation === "none";
      },
      get children() {
        var _el$38 = _$createElement("text");
        _$insertNode(_el$38, _$createTextNode(`no git · one writer at a time`));
        _$effect(_$p => _$setProp(_el$38, "fg", colors.muted, _$p));
        return _el$38;
      }
    }), _el$40);
    _$insertNode(_el$40, _el$41);
    _$insertNode(_el$40, _el$42);
    _$setProp(_el$40, "flexDirection", "row");
    _$insert(_el$40, _$createComponent(For, {
      get each() {
        return sidebarCounts(groups());
      },
      children: c => (() => {
        var _el$44 = _$createElement("text"),
          _el$45 = _$createTextNode(` `);
        _$insertNode(_el$44, _el$45);
        _$insert(_el$44, () => c.text, _el$45);
        _$effect(_$p => _$setProp(_el$44, "fg", colors.mark[c.mark], _$p));
        return _el$44;
      })()
    }), _el$41);
    _$setProp(_el$41, "flexGrow", 1);
    _$insertNode(_el$42, _el$43);
    _$insert(_el$42, () => props.job.total, null);
    _$insert(_el$33, _$createComponent(For, {
      get each() {
        return groups();
      },
      children: group => {
        const shut = () => foldable(group.key) && folded().has(group.key);
        const count = () => foldable(group.key) ? `${group.count} ${shut() ? "▸" : "▾"}` : group.lines.length < group.count ? `${group.lines.length} of ${group.count}` : String(group.count);
        return (() => {
          var _el$46 = _$createElement("box"),
            _el$47 = _$createElement("box"),
            _el$48 = _$createElement("text"),
            _el$49 = _$createElement("box"),
            _el$50 = _$createElement("text");
          _$insertNode(_el$46, _el$47);
          _$setProp(_el$46, "paddingTop", 1);
          _$insertNode(_el$47, _el$48);
          _$insertNode(_el$47, _el$49);
          _$insertNode(_el$47, _el$50);
          _$setProp(_el$47, "flexDirection", "row");
          _$setProp(_el$47, "onMouseUp", () => foldable(group.key) && toggle(group.key));
          _$insert(_el$48, () => group.name);
          _$setProp(_el$49, "flexGrow", 1);
          _$insert(_el$50, count);
          _$insert(_el$46, _$createComponent(For, {
            get each() {
              return _$memo(() => !!shut())() ? [] : group.lines;
            },
            children: line => {
              const key = `${props.job.id}/${line.id}`;
              const open = () => grown().has(key);
              const sub = () => taskSessions(line.sessions ?? [], props.facts, props.live);
              return (() => {
                var _el$51 = _$createElement("box"),
                  _el$52 = _$createElement("box"),
                  _el$53 = _$createElement("text"),
                  _el$54 = _$createTextNode(` `),
                  _el$55 = _$createElement("text"),
                  _el$56 = _$createElement("box");
                _$insertNode(_el$51, _el$52);
                _$insertNode(_el$52, _el$53);
                _$insertNode(_el$52, _el$55);
                _$insertNode(_el$52, _el$56);
                _$setProp(_el$52, "flexDirection", "row");
                _$setProp(_el$52, "onMouseUp", () => line.sessions?.length && grow(key));
                _$insertNode(_el$53, _el$54);
                _$insert(_el$53, () => BOX[line.mark], _el$54);
                _$insert(_el$55, () => cut(`${line.id} ${line.title}`, line.detail ? 24 : 32));
                _$setProp(_el$56, "flexGrow", 1);
                _$insert(_el$52, _$createComponent(Show, {
                  get when() {
                    return line.detail;
                  },
                  get children() {
                    var _el$57 = _$createElement("text");
                    _$insert(_el$57, () => line.detail);
                    _$effect(_$p => _$setProp(_el$57, "fg", colors.muted, _$p));
                    return _el$57;
                  }
                }), null);
                _$insert(_el$52, _$createComponent(Show, {
                  get when() {
                    return line.sessions?.length;
                  },
                  get children() {
                    var _el$58 = _$createElement("text");
                    _$insert(_el$58, () => open() ? " ▾" : " ▸");
                    _$effect(_$p => _$setProp(_el$58, "fg", colors.muted, _$p));
                    return _el$58;
                  }
                }), null);
                _$insert(_el$51, _$createComponent(Show, {
                  get when() {
                    return open();
                  },
                  get children() {
                    return [_$createComponent(For, {
                      get each() {
                        return sub().rows;
                      },
                      children: row => _$createComponent(SubagentRow, {
                        get context() {
                          return props.context;
                        },
                        row: row
                      })
                    }), _$createComponent(Show, {
                      get when() {
                        return sub().hidden > 0;
                      },
                      get children() {
                        var _el$59 = _$createElement("text");
                        _$insert(_el$59, () => `    +${sub().hidden} more`);
                        _$effect(_$p => _$setProp(_el$59, "fg", colors.muted, _$p));
                        return _el$59;
                      }
                    })];
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$0 = colors.mark[line.mark],
                    _v$1 = line.mark === "open" || line.mark === "done" || line.mark === "dropped" ? colors.muted : colors.base;
                  _v$0 !== _p$.e && (_p$.e = _$setProp(_el$53, "fg", _v$0, _p$.e));
                  _v$1 !== _p$.t && (_p$.t = _$setProp(_el$55, "fg", _v$1, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$51;
              })();
            }
          }), null);
          _$effect(_p$ => {
            var _v$8 = colors.base,
              _v$9 = colors.muted;
            _v$8 !== _p$.e && (_p$.e = _$setProp(_el$48, "fg", _v$8, _p$.e));
            _v$9 !== _p$.t && (_p$.t = _$setProp(_el$50, "fg", _v$9, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$46;
        })();
      }
    }), null);
    _$effect(_p$ => {
      var _v$5 = colors.base,
        _v$6 = colors.muted,
        _v$7 = colors.muted;
      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$37, "fg", _v$6, _p$.t));
      _v$7 !== _p$.a && (_p$.a = _$setProp(_el$42, "fg", _v$7, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$33;
  })();
}

// The session's checklist: its newest job in full, older open jobs as one folded line each (the user, 2026-10-20: two
// jobs of one session showed two FAILED groups).
function Checklist(props) {
  const jobs = useJobs(props.context, () => props.sessionID);
  const [waiting, setWaiting] = createSignal(new Map());
  const [opened, setOpened] = createSignal(new Set());
  const [asks, setAsks] = createSignal([]); // the micromanager's own open forms: what they ask
  const [facts, setFacts] = createSignal([]); // the sessions, for the subagents under a task
  const [live, setLive] = createSignal({
    active: new Set(),
    asking: new Set()
  });
  const colors = palette(props.context);
  const poll = async () => {
    const forms = items(await props.context.client.form?.list({}).catch(() => undefined));
    setAsks(forms.filter(f => f.sessionID === props.sessionID).map(f => f.fields?.map(x => x.title).filter(Boolean).join(" · ") || f.title || "a question"));
    const running = jobs().flatMap(j => j.rows.filter(r => ["running", "gating", "fixing", "reviewing"].includes(r.status) && r.session).map(r => r.session));
    const found = running.length ? await pending(props.context, running) : new Map();
    setWaiting(new Map([...found].map(([id, p]) => [id, p.what])));
    // The sessions and their tags, read the way the workers panel reads them: an unfolded task draws what each
    // session does from here, and an idle sidebar pays for two local calls every other poll.
    setFacts(items(await props.context.client.session.list({
      limit: 200
    }).catch(() => undefined)));
    setLive({
      active: new Set(ids(await props.context.client.session.active({}).catch(() => undefined))),
      asking: new Set(found.keys())
    });
  };
  void poll();
  const timer = setInterval(() => void poll(), POLL_MS * 2);
  onCleanup(() => clearInterval(timer));
  const split = () => sessionJobs(jobs());
  const flip = id => setOpened(was => {
    const next = new Set(was);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  return (() => {
    var _el$60 = _$createElement("box");
    _$insert(_el$60, _$createComponent(For, {
      get each() {
        return asks();
      },
      children: what => (() => {
        var _el$61 = _$createElement("box"),
          _el$62 = _$createElement("text"),
          _el$64 = _$createElement("text");
        _$insertNode(_el$61, _el$62);
        _$insertNode(_el$61, _el$64);
        _$setProp(_el$61, "flexDirection", "row");
        _$setProp(_el$61, "paddingBottom", 1);
        _$insertNode(_el$62, _$createTextNode(`[?] `));
        _$insert(_el$64, () => cut(`asks you: ${what}`, 34));
        _$effect(_p$ => {
          var _v$10 = colors.mark.waiting,
            _v$11 = colors.base;
          _v$10 !== _p$.e && (_p$.e = _$setProp(_el$62, "fg", _v$10, _p$.e));
          _v$11 !== _p$.t && (_p$.t = _$setProp(_el$64, "fg", _v$11, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$61;
      })()
    }), null);
    _$insert(_el$60, _$createComponent(Show, {
      get when() {
        return split().main;
      },
      children: main => _$createComponent(JobChecklist, {
        get context() {
          return props.context;
        },
        get job() {
          return main();
        },
        get waiting() {
          return waiting();
        },
        get facts() {
          return facts();
        },
        get live() {
          return live();
        },
        get project() {
          return projectFor(props.context, props.sessionID);
        },
        get own() {
          return main().facilitator === props.sessionID;
        }
      })
    }), null);
    _$insert(_el$60, _$createComponent(For, {
      get each() {
        return split().others;
      },
      children: job => (() => {
        var _el$65 = _$createElement("box"),
          _el$66 = _$createElement("box"),
          _el$67 = _$createElement("text"),
          _el$68 = _$createElement("box"),
          _el$69 = _$createElement("text");
        _$insertNode(_el$65, _el$66);
        _$setProp(_el$65, "paddingTop", 1);
        _$insertNode(_el$66, _el$67);
        _$insertNode(_el$66, _el$68);
        _$insertNode(_el$66, _el$69);
        _$setProp(_el$66, "flexDirection", "row");
        _$setProp(_el$66, "onMouseUp", () => flip(job.id));
        _$insert(_el$67, () => foldedLine(job));
        _$setProp(_el$68, "flexGrow", 1);
        _$insert(_el$69, () => opened().has(job.id) ? "▾" : "▸");
        _$insert(_el$65, _$createComponent(Show, {
          get when() {
            return opened().has(job.id);
          },
          get children() {
            return _$createComponent(JobChecklist, {
              get context() {
                return props.context;
              },
              job: job,
              get waiting() {
                return waiting();
              },
              get facts() {
                return facts();
              },
              get live() {
                return live();
              }
            });
          }
        }), null);
        _$effect(_p$ => {
          var _v$12 = job.phase === "ask_user" ? colors.mark.waiting : colors.muted,
            _v$13 = colors.muted;
          _v$12 !== _p$.e && (_p$.e = _$setProp(_el$67, "fg", _v$12, _p$.e));
          _v$13 !== _p$.t && (_p$.t = _$setProp(_el$69, "fg", _v$13, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$65;
      })()
    }), null);
    return _el$60;
  })();
}

// The CONTEXT section: folded to one line; unfolded the session's context as a bar (│ marks where a summary starts),
// what its epochs removed, the memory and the notes the last request got. The workers' own context lives under their
// task in the checklist, where the worker and its subagents are unfolded.
function ContextSection(props) {
  const colors = palette(props.context);
  const [open, setOpen] = createSignal(false);
  const [status, setStatus] = createSignal(readStatus(props.sessionID));
  const [mem, setMem] = createSignal(readMemoryStats());
  const poll = () => {
    setStatus(readStatus(props.sessionID));
    setMem(readMemoryStats());
  };
  const timer = setInterval(poll, POLL_MS);
  onCleanup(() => clearInterval(timer));
  const full = s => s.tokens >= s.summaryAt;
  return _$createComponent(Show, {
    get when() {
      return status() || mem();
    },
    get children() {
      var _el$70 = _$createElement("box"),
        _el$71 = _$createElement("box"),
        _el$72 = _$createElement("text"),
        _el$74 = _$createElement("box"),
        _el$75 = _$createElement("text");
      _$insertNode(_el$70, _el$71);
      _$setProp(_el$70, "paddingTop", 1);
      _$insertNode(_el$71, _el$72);
      _$insertNode(_el$71, _el$74);
      _$insertNode(_el$71, _el$75);
      _$setProp(_el$71, "flexDirection", "row");
      _$setProp(_el$71, "onMouseUp", () => setOpen(!open()));
      _$insertNode(_el$72, _$createTextNode(`CONTEXT`));
      _$setProp(_el$74, "flexGrow", 1);
      _$insert(_el$75, () => open() ? "▾" : "▸");
      _$insert(_el$70, _$createComponent(Show, {
        get when() {
          return open();
        },
        get fallback() {
          return (() => {
            var _el$78 = _$createElement("text");
            _$insert(_el$78, () => cut(foldedContext(status(), mem()), 36));
            _$effect(_$p => _$setProp(_el$78, "fg", colors.muted, _$p));
            return _el$78;
          })();
        },
        get children() {
          return [_$createComponent(Show, {
            get when() {
              return status();
            },
            children: s => (() => {
              var _el$79 = _$createElement("box"),
                _el$80 = _$createElement("box"),
                _el$81 = _$createElement("text"),
                _el$82 = _$createElement("box"),
                _el$83 = _$createElement("text"),
                _el$84 = _$createTextNode(`/`),
                _el$85 = _$createElement("text");
              _$insertNode(_el$79, _el$80);
              _$insertNode(_el$79, _el$85);
              _$insertNode(_el$80, _el$81);
              _$insertNode(_el$80, _el$82);
              _$insertNode(_el$80, _el$83);
              _$setProp(_el$80, "flexDirection", "row");
              _$insert(_el$81, () => bar(s().tokens, s().ceiling, s().summaryAt, 22));
              _$setProp(_el$82, "flexGrow", 1);
              _$insertNode(_el$83, _el$84);
              _$insert(_el$83, () => kTokens(s().tokens), _el$84);
              _$insert(_el$83, () => kTokens(s().ceiling), null);
              _$insert(_el$85, () => cut(`epochs ${s().epochs} · pruned ${kTokens(s().savedChars)} chars · ${s().pending} waiting`, 36));
              _$effect(_p$ => {
                var _v$16 = full(s()) ? colors.mark.waiting : colors.mark.running,
                  _v$17 = colors.muted,
                  _v$18 = colors.muted;
                _v$16 !== _p$.e && (_p$.e = _$setProp(_el$81, "fg", _v$16, _p$.e));
                _v$17 !== _p$.t && (_p$.t = _$setProp(_el$83, "fg", _v$17, _p$.t));
                _v$18 !== _p$.a && (_p$.a = _$setProp(_el$85, "fg", _v$18, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$79;
            })()
          }), _$createComponent(Show, {
            get when() {
              return mem();
            },
            children: m => (() => {
              var _el$86 = _$createElement("box"),
                _el$87 = _$createElement("text");
              _$insertNode(_el$86, _el$87);
              _$insert(_el$87, () => cut(`memory ${m().entries} · core ${kTokens(m().coreChars)} · ${m().vectors ? "● vectors" : "○ keywords"}`, 36));
              _$insert(_el$86, _$createComponent(Show, {
                get when() {
                  return m().writes.added || m().writes.duplicate || m().writes.contradicts;
                },
                get children() {
                  var _el$88 = _$createElement("text");
                  _$insert(_el$88, () => cut(`today +${m().writes.added} · ${m().writes.duplicate} dupes${m().writes.contradicts ? ` · ${m().writes.contradicts} ⚡ conflict` : ""}`, 36));
                  _$effect(_$p => _$setProp(_el$88, "fg", m().writes.contradicts ? colors.mark.waiting : colors.muted, _$p));
                  return _el$88;
                }
              }), null);
              _$effect(_$p => _$setProp(_el$87, "fg", colors.muted, _$p));
              return _el$86;
            })()
          }), _$createComponent(Show, {
            get when() {
              return status()?.recalled?.length;
            },
            get children() {
              return [(() => {
                var _el$76 = _$createElement("text");
                _$insertNode(_el$76, _$createTextNode(`recalled`));
                _$effect(_$p => _$setProp(_el$76, "fg", colors.base, _$p));
                return _el$76;
              })(), _$createComponent(For, {
                get each() {
                  return (status()?.recalled ?? []).slice(0, 3);
                },
                children: note => (() => {
                  var _el$89 = _$createElement("text");
                  _$insert(_el$89, () => cut(`· ${note}`, 36));
                  _$effect(_$p => _$setProp(_el$89, "fg", colors.muted, _$p));
                  return _el$89;
                })()
              })];
            }
          })];
        }
      }), null);
      _$effect(_p$ => {
        var _v$14 = colors.base,
          _v$15 = colors.muted;
        _v$14 !== _p$.e && (_p$.e = _$setProp(_el$72, "fg", _v$14, _p$.e));
        _v$15 !== _p$.t && (_p$.t = _$setProp(_el$75, "fg", _v$15, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$70;
    }
  });
}

// The session's model, which is the micromanager's when it runs in this session.
function sessionModel(context) {
  const m = context.ui.model.current();
  return m ? `${m.providerID}/${m.modelID}` : undefined;
}
function rows() {
  return poolRows(loadRouting(), loadPicks());
}

// The MODELS section: folded to one line, unfolded a line per role with its pool; a click on a role opens its popup.
function Pools(props) {
  const context = props.context;
  const colors = palette(context);
  const [open, setOpen] = createSignal(false);
  const [pools, setPools] = createSignal(rows());
  const [model, setModel] = createSignal(sessionModel(context));
  const timer = setInterval(() => {
    setPools(rows());
    setModel(sessionModel(context));
  }, POLL_MS);
  onCleanup(() => clearInterval(timer));
  const line = (name, models, mark, onClick) => (() => {
    var _el$90 = _$createElement("box"),
      _el$91 = _$createElement("text"),
      _el$92 = _$createElement("text"),
      _el$93 = _$createElement("box"),
      _el$94 = _$createElement("text");
    _$insertNode(_el$90, _el$91);
    _$insertNode(_el$90, _el$92);
    _$insertNode(_el$90, _el$93);
    _$insertNode(_el$90, _el$94);
    _$setProp(_el$90, "flexDirection", "row");
    _$setProp(_el$90, "onMouseUp", onClick);
    _$insert(_el$91, () => name.padEnd(13));
    _$insert(_el$92, () => cut(models, 20));
    _$setProp(_el$93, "flexGrow", 1);
    _$insert(_el$94, mark);
    _$effect(_p$ => {
      var _v$19 = colors.base,
        _v$20 = colors.muted,
        _v$21 = colors.mark.running;
      _v$19 !== _p$.e && (_p$.e = _$setProp(_el$91, "fg", _v$19, _p$.e));
      _v$20 !== _p$.t && (_p$.t = _$setProp(_el$92, "fg", _v$20, _p$.t));
      _v$21 !== _p$.a && (_p$.a = _$setProp(_el$94, "fg", _v$21, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$90;
  })();
  return (() => {
    var _el$95 = _$createElement("box"),
      _el$96 = _$createElement("box"),
      _el$97 = _$createElement("text"),
      _el$99 = _$createElement("box"),
      _el$100 = _$createElement("text");
    _$insertNode(_el$95, _el$96);
    _$setProp(_el$95, "paddingTop", 1);
    _$insertNode(_el$96, _el$97);
    _$insertNode(_el$96, _el$99);
    _$insertNode(_el$96, _el$100);
    _$setProp(_el$96, "flexDirection", "row");
    _$setProp(_el$96, "onMouseUp", () => setOpen(!open()));
    _$insertNode(_el$97, _$createTextNode(`MODELS`));
    _$setProp(_el$99, "flexGrow", 1);
    _$insert(_el$100, () => open() ? "/pools ▾" : "/pools ▸");
    _$insert(_el$95, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        return [_$memo(() => line("micromanager", model()?.split("/").pop() ?? "", "", () => context.ui.toast.show({
          message: "The micromanager runs on this session's model: change it with /model."
        }))), _$createComponent(For, {
          get each() {
            return pools();
          },
          children: row => line(row.agent, shortNames(row.models).join(" "), row.own ? "✎" : "", () => void pickModels(context, row.key))
        })];
      }
    }), null);
    _$effect(_p$ => {
      var _v$22 = colors.base,
        _v$23 = colors.muted;
      _v$22 !== _p$.e && (_p$.e = _$setProp(_el$97, "fg", _v$22, _p$.e));
      _v$23 !== _p$.t && (_p$.t = _$setProp(_el$100, "fg", _v$23, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$95;
  })();
}

// The popup: step 1 picks the agent, step 2 its models. A plugin's select has no keys of its own, so ↵ checks or
// unchecks a model and the popup opens again on it; esc ends. Every change is saved at once, except "clear all": its
// empty pool stays in the popup until a model is checked, and esc before that keeps the saved pool.
async function pickModels(context, key) {
  if (!key) {
    const chosen = await context.ui.dialog.select({
      title: "Micromanager: models per agent",
      placeholder: "agent",
      options: agentOptions(rows(), sessionModel(context))
    });
    if (chosen === "micromanager") return context.ui.toast.show({
      message: "The micromanager runs on this session's model: change it with /model."
    });
    if (!chosen) return;
    key = chosen;
  }
  const catalog = items(await context.client.model.list({}).catch(() => undefined));
  const routing = loadRouting();
  const weekly = new Map();
  for (const pick of seedFromJournal()) weekly.set(pick.model, (weekly.get(pick.model) ?? 0) + 1);
  const budget = _model => undefined;
  let current;
  let cleared = false;
  for (;;) {
    const saved = poolRows(routing, loadPicks()).find(r => r.key === key);
    if (!saved) return;
    const row = cleared ? {
      ...saved,
      models: []
    } : saved;
    const title = key === VISION ? "vision · ↵ picks the image model" : `${row.agent} · ↵ check · esc done`;
    const chosen = await context.ui.dialog.select({
      title,
      placeholder: "model",
      current,
      options: modelOptions(catalog, row, m => weekly.get(m) ?? 0, budget)
    });
    if (!chosen) {
      if (cleared) context.ui.toast.show({
        message: `${row.agent}: nothing checked, the pool stays ${shortNames(saved.models).join(" ")}.`
      });
      return;
    }
    current = chosen;
    if (chosen === CLEAR) {
      cleared = true;
      continue;
    }
    cleared = false;
    const models = chosen === RESET ? RESET : toggle(row, chosen);
    if (!models) {
      context.ui.toast.show({
        message: `${row.agent} needs at least one model.`
      });
      continue;
    }
    savePicks(updatePicks(loadPicks(), routing, key, models));
    if (key === VISION || chosen === RESET) {
      context.ui.toast.show({
        message: `${row.agent}: ${shortNames(poolRows(routing, loadPicks()).find(r => r.key === key).models).join(" ")}`,
        variant: "success"
      });
      return;
    }
  }
}

// The agent switcher: every recent session with its workers, live; keys move, open, stop and answer.
function Agents(props) {
  const context = props.context;
  const colors = palette(context);
  const [rows, setRows] = createSignal([]);
  const [asks, setAsks] = createSignal(new Map());
  const [at, setAt] = createSignal(0);
  const refresh = async () => {
    const sessions = items(await context.client.session.list({
      limit: 200
    }).catch(() => undefined));
    const active = new Set(ids(await context.client.session.active({}).catch(() => undefined)));
    const jobs = jobsOf(context, props.panel.sessionID);
    const found = await pending(context, [...active]);
    setAsks(found);
    setRows(agentRows(sessions, {
      active,
      asking: new Set(found.keys())
    }, jobs, props.panel.sessionID));
    if (at() >= rows().length) setAt(Math.max(0, rows().length - 1));
  };
  void refresh();
  const timer = setInterval(() => void refresh(), POLL_MS * 1.5);
  onCleanup(() => clearInterval(timer));
  const chosen = () => rows()[at()];
  const answer = async decision => {
    const row = chosen();
    const ask = row && asks().get(row.id);
    if (!row || !ask?.requestID) return context.ui.toast.show({
      message: "Nothing to answer there."
    });
    await context.client.permission.reply({
      sessionID: row.id,
      requestID: ask.requestID,
      decision
    }).then(() => context.ui.toast.show({
      message: `${decision === "once" ? "Allowed" : "Refused"}: ${ask.what}`,
      variant: "success"
    })).catch(err => context.ui.toast.show({
      message: `Could not answer: ${String(err)}`,
      variant: "error"
    }));
    void refresh();
  };
  const on = () => props.panel.focused !== false;
  context.keymap.layer(() => ({
    commands: [{
      id: "micromanager.agents.up",
      bind: "up,k",
      enabled: on,
      run: () => setAt(Math.max(0, at() - 1))
    }, {
      id: "micromanager.agents.down",
      bind: "down,j",
      enabled: on,
      run: () => setAt(Math.min(rows().length - 1, at() + 1))
    }, {
      id: "micromanager.agents.open",
      bind: "return",
      enabled: on,
      run: () => {
        const r = chosen();
        if (r) {
          props.panel.close();
          context.ui.router.navigate({
            type: "session",
            sessionID: r.id
          });
        }
      }
    }, {
      id: "micromanager.agents.stop",
      bind: "x",
      enabled: on,
      run: () => {
        const r = chosen();
        if (r) void context.client.session.interrupt({
          sessionID: r.id
        }).then(() => context.ui.toast.show({
          message: `Stopped ${cut(r.title, 40)}`
        })).catch(() => undefined);
      }
    }, {
      id: "micromanager.agents.yes",
      bind: "y",
      enabled: on,
      run: () => void answer("once")
    }, {
      id: "micromanager.agents.no",
      bind: "n",
      enabled: on,
      run: () => void answer("reject")
    }, {
      id: "micromanager.agents.close",
      bind: "escape",
      enabled: on,
      run: () => props.panel.close()
    }]
  }));
  return (() => {
    var _el$101 = _$createElement("box"),
      _el$102 = _$createElement("box"),
      _el$103 = _$createElement("text"),
      _el$105 = _$createElement("box"),
      _el$106 = _$createElement("text"),
      _el$107 = _$createElement("box"),
      _el$108 = _$createElement("text");
    _$insertNode(_el$101, _el$102);
    _$insertNode(_el$101, _el$107);
    _$setProp(_el$101, "paddingLeft", 1);
    _$setProp(_el$101, "paddingRight", 1);
    _$insertNode(_el$102, _el$103);
    _$insertNode(_el$102, _el$105);
    _$insertNode(_el$102, _el$106);
    _$setProp(_el$102, "flexDirection", "row");
    _$insertNode(_el$103, _$createTextNode(`Agents`));
    _$setProp(_el$105, "flexGrow", 1);
    _$insert(_el$106, () => agentSummary(rows()));
    _$insert(_el$101, _$createComponent(For, {
      get each() {
        return rows();
      },
      children: (row, i) => (() => {
        var _el$110 = _$createElement("box"),
          _el$111 = _$createElement("text"),
          _el$112 = _$createElement("text"),
          _el$113 = _$createTextNode(` `),
          _el$114 = _$createElement("text"),
          _el$115 = _$createElement("box"),
          _el$116 = _$createElement("text");
        _$insertNode(_el$110, _el$111);
        _$insertNode(_el$110, _el$112);
        _$insertNode(_el$110, _el$114);
        _$insertNode(_el$110, _el$115);
        _$insertNode(_el$110, _el$116);
        _$setProp(_el$110, "flexDirection", "row");
        _$setProp(_el$110, "onMouseUp", () => setAt(i()));
        _$insert(_el$111, () => i() === at() ? "› " : "  ");
        _$insertNode(_el$112, _el$113);
        _$insert(_el$112, () => row.depth ? "  " : "", _el$113);
        _$insert(_el$112, () => row.tag.padEnd(4), _el$113);
        _$insert(_el$114, () => cut(row.title, row.depth ? 38 : 44));
        _$setProp(_el$115, "flexGrow", 1);
        _$insert(_el$116, () => [row.agent, row.model, row.elapsed, asks().get(row.id)?.what ?? "", row.cost ? `$${row.cost.toFixed(2)}` : ""].filter(Boolean).join("  "));
        _$effect(_p$ => {
          var _v$27 = row.depth === 0 && i() > 0 ? 1 : 0,
            _v$28 = i() === at() ? colors.mark.running : colors.muted,
            _v$29 = colors.tag[row.tag],
            _v$30 = row.depth ? colors.base : colors.base,
            _v$31 = colors.muted;
          _v$27 !== _p$.e && (_p$.e = _$setProp(_el$110, "paddingTop", _v$27, _p$.e));
          _v$28 !== _p$.t && (_p$.t = _$setProp(_el$111, "fg", _v$28, _p$.t));
          _v$29 !== _p$.a && (_p$.a = _$setProp(_el$112, "fg", _v$29, _p$.a));
          _v$30 !== _p$.o && (_p$.o = _$setProp(_el$114, "fg", _v$30, _p$.o));
          _v$31 !== _p$.i && (_p$.i = _$setProp(_el$116, "fg", _v$31, _p$.i));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined
        });
        return _el$110;
      })()
    }), _el$107);
    _$insertNode(_el$107, _el$108);
    _$setProp(_el$107, "paddingTop", 1);
    _$insertNode(_el$108, _$createTextNode(`↑↓ move ↵ open x stop y/n answer esc close`));
    _$effect(_p$ => {
      var _v$24 = colors.base,
        _v$25 = colors.muted,
        _v$26 = colors.muted;
      _v$24 !== _p$.e && (_p$.e = _$setProp(_el$103, "fg", _v$24, _p$.e));
      _v$25 !== _p$.t && (_p$.t = _$setProp(_el$106, "fg", _v$25, _p$.t));
      _v$26 !== _p$.a && (_p$.a = _$setProp(_el$108, "fg", _v$26, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$101;
  })();
}

// The services popup: step 1 a service (or the idle time), step 2 its mode or its device. Every pick is saved at once
// and the popup opens again on step 1, so its lines show the new modes; esc ends. From the sidebar, a click on a
// service opens step 2 for it directly, and esc there ends.
async function pickServices(context, only) {
  let current = only ? `service:${only}` : undefined;
  for (;;) {
    const view = servicesView();
    if (!view.running) return context.ui.toast.show({
      message: "omacode-services is not running: npm run services -- install",
      variant: "warning"
    });
    let chosen = current;
    if (!only) {
      const options = [...view.services.map(s => ({
        title: s.name,
        value: `service:${s.name}`,
        description: serviceLine(s)
      })), {
        title: "idle time",
        value: "idle",
        description: `services in auto stop after ${view.idleMinutes ?? 10} min without a request`
      }];
      chosen = await context.ui.dialog.select({
        title: "Omacode services · ↵ change · esc done",
        placeholder: "service",
        current,
        options
      });
      if (!chosen) return;
      current = chosen;
    }
    if (chosen === "idle") {
      await pickIdle(context, view.idleMinutes);
      continue;
    }
    const service = view.services.find(s => `service:${s.name}` === chosen);
    if (!service) return;
    await pickService(context, service);
    if (only) return;
  }
}
async function pickIdle(context, now = 10) {
  const minutes = await context.ui.dialog.select({
    title: "Idle time before a service in auto stops",
    current: String(now),
    options: IDLE_CHOICES.map(m => ({
      title: `${m} min`,
      value: String(m)
    }))
  });
  if (minutes) setIdleMinutes(Number(minutes));
}
async function pickService(context, service) {
  const devices = service.devices ?? [];
  const picked = await context.ui.dialog.select({
    title: `${service.name} · now ${serviceLine(service)}`,
    current: service.mode,
    options: [...MODES.map(m => ({
      title: m,
      value: m,
      description: MODE_HELP[m],
      category: "mode"
    })),
    // One device is shown as well, with its note, so the popup says why there is nothing to pick.
    ...devices.map(d => ({
      title: d.id === service.device ? `● ${d.name}` : d.name,
      value: `device:${d.id}`,
      description: d.note ?? d.id,
      category: "runs on"
    }))]
  });
  if (!picked) return;
  if (picked.startsWith("device:")) {
    const id = picked.slice("device:".length);
    const note = devices.find(d => d.id === id)?.note;
    if (devices.length === 1) return context.ui.toast.show({
      message: `${service.name}: ${note ?? `runs on ${deviceName(service, id)} only`}`
    });
    if (id === service.device) return;
    setServiceDevice(service.name, id);
    return context.ui.toast.show({
      message: `${service.name}: moving to ${deviceName(service, id)}`,
      variant: "success"
    });
  }
  if (picked === service.mode) return;
  setServiceMode(service.name, picked);
  context.ui.toast.show({
    message: `${service.name}: ${picked}`,
    variant: picked === "off" ? "warning" : "success"
  });
}

// The sidebar's SERVICES section, below MODELS: folded, one line per service with its mode, state and device; a click
// on a line opens its popup, on the idle line the idle time. Read from the supervisor's status file every poll.
const STATE_MARK = {
  running: "●",
  starting: "◐",
  preparing: "◐",
  stopped: "○",
  failed: "✖"
};
function Services(props) {
  const context = props.context;
  const colors = palette(context);
  const [open, setOpen] = createSignal(false);
  const [view, setView] = createSignal(servicesView());
  const timer = setInterval(() => setView(servicesView()), POLL_MS);
  onCleanup(() => clearInterval(timer));
  const short = s => [s.mode, s.mode === "off" ? undefined : s.state, s.device && s.devices && s.devices.length > 1 ? s.device : undefined].filter(Boolean).join(" · ");
  const line = (name, text, mark, color, onClick) => (() => {
    var _el$117 = _$createElement("box"),
      _el$118 = _$createElement("text"),
      _el$119 = _$createElement("text"),
      _el$120 = _$createElement("box"),
      _el$121 = _$createElement("text");
    _$insertNode(_el$117, _el$118);
    _$insertNode(_el$117, _el$119);
    _$insertNode(_el$117, _el$120);
    _$insertNode(_el$117, _el$121);
    _$setProp(_el$117, "flexDirection", "row");
    _$setProp(_el$117, "onMouseUp", onClick);
    _$insert(_el$118, () => name.padEnd(13));
    _$insert(_el$119, () => cut(text, 20));
    _$setProp(_el$120, "flexGrow", 1);
    _$setProp(_el$121, "fg", color);
    _$insert(_el$121, mark);
    _$effect(_p$ => {
      var _v$32 = colors.base,
        _v$33 = colors.muted;
      _v$32 !== _p$.e && (_p$.e = _$setProp(_el$118, "fg", _v$32, _p$.e));
      _v$33 !== _p$.t && (_p$.t = _$setProp(_el$119, "fg", _v$33, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$117;
  })();
  return (() => {
    var _el$122 = _$createElement("box"),
      _el$123 = _$createElement("box"),
      _el$124 = _$createElement("text"),
      _el$126 = _$createElement("box"),
      _el$127 = _$createElement("text");
    _$insertNode(_el$122, _el$123);
    _$setProp(_el$122, "paddingTop", 1);
    _$insertNode(_el$123, _el$124);
    _$insertNode(_el$123, _el$126);
    _$insertNode(_el$123, _el$127);
    _$setProp(_el$123, "flexDirection", "row");
    _$setProp(_el$123, "onMouseUp", () => setOpen(!open()));
    _$insertNode(_el$124, _$createTextNode(`SERVICES`));
    _$setProp(_el$126, "flexGrow", 1);
    _$insert(_el$127, () => open() ? "/services ▾" : "/services ▸");
    _$insert(_el$122, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return view().running;
          },
          get fallback() {
            return line("not running", "npm run services", "", colors.muted, () => void pickServices(context));
          },
          get children() {
            return [_$createComponent(For, {
              get each() {
                return view().services;
              },
              children: s => line(s.name, short(s), s.mode === "off" ? "○" : STATE_MARK[s.state] ?? "", s.state === "failed" ? colors.mark.failed : s.state === "running" ? colors.mark.running : colors.muted, () => void pickServices(context, s.name))
            }), _$memo(() => line("idle", `${view().idleMinutes ?? 10} min`, "", colors.muted, () => void pickIdle(context, view().idleMinutes)))];
          }
        });
      }
    }), null);
    _$effect(_p$ => {
      var _v$34 = colors.base,
        _v$35 = colors.muted;
      _v$34 !== _p$.e && (_p$.e = _$setProp(_el$124, "fg", _v$34, _p$.e));
      _v$35 !== _p$.t && (_p$.t = _$setProp(_el$127, "fg", _v$35, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$122;
  })();
}

// A command on the job of the session on screen: its newest job with tasks.
function onJob(context, run) {
  const sessionID = context.ui.router.current()?.sessionID;
  const project = sessionID && projectFor(context, sessionID);
  const job = sessionID ? sessionJobs(read(context, sessionID)).main : undefined;
  if (!project || !job) return context.ui.toast.show({
    message: "No micromanager job in this session."
  });
  void run(project, job);
}
async function openTask(context) {
  const sessionID = context.ui.router.current()?.sessionID;
  const options = sessionID ? taskChoices(read(context, sessionID), sessionID) : [];
  if (!sessionID || !options.length) return context.ui.toast.show({
    message: "No micromanager job in this session."
  });
  const chosen = await context.ui.dialog.select({
    title: "Micromanager tasks",
    options
  });
  if (chosen) context.ui.router.navigate({
    type: "session",
    sessionID: chosen
  });else if (chosen === "") context.ui.toast.show({
    message: "That task has no session yet."
  });
}

// Installing an optional part from the TUI (features.ts): asked with its purpose, size and licence; ComfyUI also asks
// for its device. A part that needs sudo is named with the command for a terminal instead. The output goes to
// install.log in the state directory, the result to a toast. True when every part asked for is there afterwards.
async function installFlow(context, parts, why = "") {
  const there = await presentState(featuresExec);
  const missing = parts.filter(id => !isPresent(id, there) && !(OFFERS[id].after && !parts.includes(OFFERS[id].after) && !isPresent(OFFERS[id].after, there)));
  if (!missing.length) return true;
  // root (a container) needs no password: system packages install from here too
  const root = process.getuid?.() === 0;
  const sudo = root ? [] : missing.filter(id => OFFERS[id].system);
  const user = root ? missing : missing.filter(id => !OFFERS[id].system);
  if (user.length) {
    const yes = await context.ui.dialog.confirm({
      title: `${why}Install ${user.map(id => OFFERS[id].title).join(" and ")}?`,
      message: user.map(id => `${OFFERS[id].title}: ${OFFERS[id].what}. ${OFFERS[id].size}. Licence: ${OFFERS[id].licence}.`).join("\n")
    });
    if (!yes) return false;
    let gpu;
    if (user.includes("comfyui")) {
      const devices = await gpus(featuresExec);
      gpu = devices.length > 1 ? await context.ui.dialog.select({
        title: "Run ComfyUI on",
        options: devices.map(g => ({
          title: g.name,
          value: g.id,
          ...(g.note ? {
            description: g.note
          } : {})
        }))
      }) : devices[0]?.id;
      if (!gpu) return false;
    }
    const logFile = join(userStateDir(), "install.log");
    mkdirSync(userStateDir(), {
      recursive: true
    });
    appendFileSync(logFile, `\n== ${new Date().toISOString()} ${user.join(", ")}\n`);
    context.ui.toast.show({
      message: `Installing ${user.map(id => OFFERS[id].title).join(", ")}; this can take minutes (${logFile})`
    });
    const outcome = await installParts(user, {
      run: featuresExec,
      log: line => appendFileSync(logFile, `${line}\n`),
      ...(gpu ? {
        gpu
      } : {})
    });
    context.ui.toast.show({
      message: `${outcomeText(outcome)}${outcome.ok ? "" : ` See ${logFile}.`}`,
      variant: outcome.ok ? "success" : "error"
    });
    if (!outcome.ok) return false;
  }
  if (sudo.length) {
    context.ui.toast.show({
      message: `${sudo.map(id => OFFERS[id].title).join(" and ")} ${sudo.length === 1 ? "needs" : "need"} sudo: run ./install.sh --with ${sudo.join(",")} in a terminal`,
      variant: "warning"
    });
  }
  return sudo.length === 0;
}

// /setup: every optional part with whether it is there. Picking a missing part ticks or unticks it; "Install" installs
// everything ticked after one confirmation (OpenCode's select picks one option, so the list comes back after each tick).
async function setupDialog(context) {
  const there = await presentState(featuresExec);
  const picked = new Set();
  const INSTALL = "__install__";
  for (;;) {
    const size = [...picked].map(id => OFFERS[id].size).join(" + ");
    const chosen = await context.ui.dialog.select({
      title: "Omacode parts · ↵ tick, then Install",
      placeholder: "part",
      options: [...(picked.size ? [{
        title: `▶ Install ${picked.size} part${picked.size === 1 ? "" : "s"}`,
        value: INSTALL,
        description: size
      }] : []), ...OFFER_IDS.map(id => {
        const o = OFFERS[id];
        const here = isPresent(id, there);
        return {
          title: `${here ? "✓" : picked.has(id) ? "[x]" : "[ ]"} ${o.title}`,
          value: id,
          description: here ? "installed" : `${o.what} · ${o.size}${o.system ? " · system package" : ""}`
        };
      })]
    });
    if (chosen === INSTALL) break;
    const id = OFFER_IDS.find(x => x === chosen);
    if (!id) return; // esc: nothing installed
    if (isPresent(id, there)) {
      context.ui.toast.show({
        message: `${OFFERS[id].title} is installed`
      });
      continue;
    }
    if (picked.has(id)) picked.delete(id);else picked.add(id);
  }
  await installFlow(context, [...picked]);
}

// The first start: what do you want to make? The answer decides which parts are offered; decks then lead to the first
// deck. Asked once, whatever the answer; /setup and /first-deck stay.
async function welcome(context) {
  if (wasOffered()) return;
  markOffered();
  const chosen = await context.ui.dialog.select({
    title: "Welcome to omacode: what do you want to make?",
    placeholder: "goal",
    options: GOALS.map(g => ({
      title: g.title,
      value: g.id
    }))
  });
  const goal = GOALS.find(g => g.id === chosen);
  if (!goal || !goal.parts.length) return;
  const ready = await installFlow(context, goal.parts, `${goal.title}: `);
  if (goal.firstDeck && (ready || (await presentState(featuresExec)).tools.some(t => t.name === "hyperframes" && t.found))) await firstDeck(context);
}

// /first-deck (C2-T7): pick a sample brief, and a new session with the build agent writes, checks and presents a deck,
// then explains what happened. HyperFrames missing, it is offered first.
async function firstDeck(context) {
  if (!hyperframesInstalled() && !(await installFlow(context, ["hyperframes"], "The first deck needs HyperFrames. ")) && !hyperframesInstalled()) return;
  const chosen = await context.ui.dialog.select({
    title: "Your first deck: pick a topic",
    placeholder: "topic",
    options: BRIEFS.map(b => ({
      title: b.title,
      value: b.id
    }))
  });
  const brief = BRIEFS.find(b => b.id === chosen);
  if (!brief) return;
  try {
    const directory = prepareFirstDeckDir(firstDeckDir(brief));
    const answer = await context.client.session.create({
      location: {
        directory
      },
      agent: "build"
    });
    const session = answer?.data ?? answer;
    if (typeof session?.id !== "string") throw new Error("the new session has no id");
    context.ui.router.navigate({
      type: "session",
      sessionID: session.id
    });
    await context.client.session.prompt({
      sessionID: session.id,
      text: firstDeckPrompt(brief)
    });
    context.ui.toast.show({
      message: `Making "${brief.title}" in ${directory}`
    });
  } catch (err) {
    context.ui.toast.show({
      message: `Could not start the first deck: ${err instanceof Error ? err.message : String(err)}`,
      variant: "error"
    });
  }
}
export default Plugin.define({
  id: "micromanager.tui",
  setup(raw) {
    const context = raw;
    context.ui.slot({
      append: "session.composer.top",
      render: input => _$createComponent(Progress, {
        context: context,
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    // prepend: at the top of the sidebar, above OpenCode's own context and MCP sections (appended, it was below the fold)
    context.ui.slot({
      prepend: "sidebar.content",
      render: input => (() => {
        var _el$128 = _$createElement("box");
        _$insert(_el$128, _$createComponent(Checklist, {
          context: context,
          get sessionID() {
            return input.sessionID;
          }
        }), null);
        _$insert(_el$128, _$createComponent(ContextSection, {
          context: context,
          get sessionID() {
            return input.sessionID;
          }
        }), null);
        _$insert(_el$128, _$createComponent(Pools, {
          context: context
        }), null);
        _$insert(_el$128, _$createComponent(Services, {
          context: context
        }), null);
        return _el$128;
      })()
    });
    context.ui.slot({
      append: "session.panel",
      render: panel => panel.name === PANEL ? _$createComponent(Agents, {
        context: context,
        panel: panel
      }) : null
    });
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "micromanager.tasks",
            title: "Micromanager: open a task's session",
            group: "Micromanager",
            palette: true,
            slash: {
              name: "tasks"
            },
            run: () => openTask(context)
          }, {
            id: "micromanager.agents",
            title: "Micromanager: agents",
            group: "Micromanager",
            palette: true,
            slash: {
              name: "workers"
            },
            run: () => context.ui.panel.open(PANEL)
          }, {
            id: "micromanager.pools",
            title: "Micromanager: models per agent",
            group: "Micromanager",
            palette: true,
            slash: {
              name: "pools"
            },
            run: () => pickModels(context)
          }, {
            id: "omacode.services",
            title: "Omacode: services on/auto/off",
            group: "Omacode",
            palette: true,
            slash: {
              name: "services"
            },
            run: () => pickServices(context)
          }, {
            id: "omacode.firstdeck",
            title: "Omacode: make a first slide deck",
            group: "Omacode",
            palette: true,
            slash: {
              name: "first-deck"
            },
            run: () => firstDeck(context)
          }, {
            id: "omacode.setup",
            title: "Omacode: install parts (services, HyperFrames, ComfyUI, …)",
            group: "Omacode",
            palette: true,
            slash: {
              name: "setup"
            },
            run: () => setupDialog(context)
          }, {
            id: "micromanager.auto",
            title: "Micromanager: auto-continue on/off",
            group: "Micromanager",
            palette: true,
            slash: {
              name: "auto"
            },
            run: () => onJob(context, (project, job) => {
              const c = flipped(project, job, "auto");
              context.ui.toast.show({
                message: `auto-continue ${c.auto ? "on" : "off"} for ${job.id}`
              });
            })
          }, {
            id: "micromanager.parallel",
            title: "Micromanager: parallel on/off",
            group: "Micromanager",
            palette: true,
            slash: {
              name: "parallel"
            },
            run: () => onJob(context, (project, job) => {
              const c = flipped(project, job, "parallel");
              context.ui.toast.show({
                message: `parallel ${c.parallel ? "on" : "off"} for ${job.id}`
              });
            })
          }, {
            id: "micromanager.stop",
            title: "Micromanager: stop or resume the job",
            group: "Micromanager",
            palette: true,
            slash: {
              name: "stop"
            },
            run: () => onJob(context, (project, job) => {
              if (!loadControl(project, job.id).stopped) return stopJob(context, project, job);
              updateControl(project, job.id, {
                stopped: false
              });
              context.ui.toast.show({
                message: `Resumed ${job.id}`,
                variant: "success"
              });
            })
          }]
        }));
        // The first start after install offers the first deck once (a dialog needs the rendered app, hence here).
        setTimeout(() => void welcome(context), 1500);
        return null;
      }
    });
  }
});