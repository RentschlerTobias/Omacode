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
import { agentOptions, CLEAR, modelOptions, poolRows, RESET, shortNames, toggle, updatePicks, VISION } from "./pools.ts";
import { BOX, foldedLine, jobsFor, projectOf, resolver, sessionJobs, sidebarCounts, sidebarGroups, summaryLine, taskChoices, view } from "./progress.ts";
import { listJobs } from "@omacode/state/store";
import { agentRows, agentSummary, taskSessions } from "./switcher.ts";
import { seedFromJournal } from "./usage.ts";
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
function Progress(props) {
  const jobs = useJobs(props.context, () => props.sessionID);
  return _$createComponent(For, {
    get each() {
      return jobs().filter(j => j.total > 0);
    },
    children: job => (() => {
      var _el$ = _$createElement("text"),
        _el$2 = _$createTextNode(`micromanager · `),
        _el$3 = _$createTextNode(` · /tasks · /workers`);
      _$insertNode(_el$, _el$2);
      _$insertNode(_el$, _el$3);
      _$insert(_el$, () => summaryLine(job), _el$3);
      _$effect(_$p => _$setProp(_el$, "fg", props.context.theme.text.muted, _$p));
      return _el$;
    })()
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
    var _el$4 = _$createElement("box"),
      _el$5 = _$createElement("box");
    _$insertNode(_el$4, _el$5);
    _$setProp(_el$5, "flexDirection", "row");
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return control().stopped;
      },
      get fallback() {
        return [(() => {
          var _el$1 = _$createElement("text"),
            _el$10 = _$createTextNode(` `);
          _$insertNode(_el$1, _el$10);
          _$setProp(_el$1, "onMouseUp", () => toggle("auto"));
          _$insert(_el$1, (() => {
            var _c$ = _$memo(() => !!(control().auto && control().pause));
            return () => _c$() ? `auto ⏸ ${control().pause}` : `${box(control().auto === true)} auto`;
          })(), _el$10);
          _$effect(_$p => _$setProp(_el$1, "fg", control().auto ? colors.mark.running : colors.muted, _$p));
          return _el$1;
        })(), (() => {
          var _el$11 = _$createElement("text"),
            _el$12 = _$createTextNode(` parallel `);
          _$insertNode(_el$11, _el$12);
          _$setProp(_el$11, "onMouseUp", () => toggle("parallel"));
          _$insert(_el$11, () => box(opts().parallel), _el$12);
          _$effect(_$p => _$setProp(_el$11, "fg", opts().parallel ? colors.base : colors.muted, _$p));
          return _el$11;
        })(), (() => {
          var _el$13 = _$createElement("text"),
            _el$14 = _$createTextNode(` review`);
          _$insertNode(_el$13, _el$14);
          _$setProp(_el$13, "onMouseUp", () => toggle("review"));
          _$insert(_el$13, () => box(opts().review), _el$14);
          _$effect(_$p => _$setProp(_el$13, "fg", opts().review ? colors.base : colors.muted, _$p));
          return _el$13;
        })(), (() => {
          var _el$15 = _$createElement("box");
          _$setProp(_el$15, "flexGrow", 1);
          return _el$15;
        })(), (() => {
          var _el$16 = _$createElement("text");
          _$insertNode(_el$16, _$createTextNode(`■ STOP`));
          _$setProp(_el$16, "onMouseUp", () => void stopJob(props.context, props.project, props.job).then(() => setControl(loadControl(props.project, props.job.id))));
          _$effect(_$p => _$setProp(_el$16, "fg", colors.mark.failed, _$p));
          return _el$16;
        })()];
      },
      get children() {
        return [(() => {
          var _el$6 = _$createElement("text");
          _$insertNode(_el$6, _$createTextNode(`■ stopped`));
          _$effect(_$p => _$setProp(_el$6, "fg", colors.mark.failed, _$p));
          return _el$6;
        })(), (() => {
          var _el$8 = _$createElement("box");
          _$setProp(_el$8, "flexGrow", 1);
          return _el$8;
        })(), (() => {
          var _el$9 = _$createElement("text");
          _$insertNode(_el$9, _$createTextNode(`resume ▸`));
          _$setProp(_el$9, "onMouseUp", () => setControl(updateControl(props.project, props.job.id, {
            stopped: false
          })));
          _$effect(_$p => _$setProp(_el$9, "fg", colors.base, _$p));
          return _el$9;
        })()];
      }
    }));
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return sandbox();
      },
      children: state => state() === "on" ? (() => {
        var _el$18 = _$createElement("text");
        _$insertNode(_el$18, _$createTextNode(`sandbox ✓`));
        _$effect(_$p => _$setProp(_el$18, "fg", colors.muted, _$p));
        return _el$18;
      })() : (() => {
        var _el$20 = _$createElement("text");
        _$insert(_el$20, () => cut(`no sandbox · ${state().replace(/^off: /, "")}`, 36));
        _$effect(_$p => _$setProp(_el$20, "fg", colors.mark.waiting, _$p));
        return _el$20;
      })()
    }), null);
    return _el$4;
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
    var _el$21 = _$createElement("box"),
      _el$22 = _$createElement("box"),
      _el$23 = _$createElement("text"),
      _el$24 = _$createElement("text"),
      _el$25 = _$createElement("box");
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$22, _el$23);
    _$insertNode(_el$22, _el$24);
    _$insertNode(_el$22, _el$25);
    _$setProp(_el$22, "flexDirection", "row");
    _$setProp(_el$22, "paddingLeft", 2);
    _$setProp(_el$22, "onMouseUp", open);
    _$insert(_el$23, () => tag().padEnd(5));
    _$insert(_el$24, () => cut(`${props.row.agent || "worker"} ${props.row.title}`, 21).padEnd(22));
    _$setProp(_el$25, "flexGrow", 1);
    _$insert(_el$22, _$createComponent(Show, {
      get when() {
        return props.row.elapsed;
      },
      get children() {
        var _el$26 = _$createElement("text");
        _$insert(_el$26, () => props.row.elapsed);
        _$effect(_$p => _$setProp(_el$26, "fg", colors.muted, _$p));
        return _el$26;
      }
    }), null);
    _$insert(_el$21, _$createComponent(SessionContextLine, {
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
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$23, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$24, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$21;
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
      var _el$27 = _$createElement("box"),
        _el$28 = _$createElement("text"),
        _el$29 = _$createElement("text");
      _$insertNode(_el$27, _el$28);
      _$insertNode(_el$27, _el$29);
      _$setProp(_el$27, "flexDirection", "row");
      _$setProp(_el$27, "paddingLeft", 2);
      _$insert(_el$28, () => bar(s().tokens, s().ceiling, s().summaryAt, 10));
      _$insert(_el$29, () => ` ${kTokens(s().tokens)}${full(s()) ? " ⚠" : ""}`);
      _$effect(_p$ => {
        var _v$3 = full(s()) ? colors.mark.waiting : colors.muted,
          _v$4 = colors.muted;
        _v$3 !== _p$.e && (_p$.e = _$setProp(_el$28, "fg", _v$3, _p$.e));
        _v$4 !== _p$.t && (_p$.t = _$setProp(_el$29, "fg", _v$4, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$27;
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
    var _el$30 = _$createElement("box"),
      _el$31 = _$createElement("box"),
      _el$32 = _$createElement("text"),
      _el$33 = _$createElement("box"),
      _el$34 = _$createElement("text"),
      _el$37 = _$createElement("box"),
      _el$38 = _$createElement("box"),
      _el$39 = _$createElement("text"),
      _el$40 = _$createTextNode(`/`);
    _$insertNode(_el$30, _el$31);
    _$insertNode(_el$30, _el$37);
    _$insertNode(_el$31, _el$32);
    _$insertNode(_el$31, _el$33);
    _$insertNode(_el$31, _el$34);
    _$setProp(_el$31, "flexDirection", "row");
    _$insert(_el$32, () => cut(props.job.title, 26));
    _$setProp(_el$33, "flexGrow", 1);
    _$insert(_el$34, () => props.job.phase);
    _$insert(_el$30, _$createComponent(Show, {
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
    }), _el$37);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return props.job.isolation === "none";
      },
      get children() {
        var _el$35 = _$createElement("text");
        _$insertNode(_el$35, _$createTextNode(`no git · one writer at a time`));
        _$effect(_$p => _$setProp(_el$35, "fg", colors.muted, _$p));
        return _el$35;
      }
    }), _el$37);
    _$insertNode(_el$37, _el$38);
    _$insertNode(_el$37, _el$39);
    _$setProp(_el$37, "flexDirection", "row");
    _$insert(_el$37, _$createComponent(For, {
      get each() {
        return sidebarCounts(groups());
      },
      children: c => (() => {
        var _el$41 = _$createElement("text"),
          _el$42 = _$createTextNode(` `);
        _$insertNode(_el$41, _el$42);
        _$insert(_el$41, () => c.text, _el$42);
        _$effect(_$p => _$setProp(_el$41, "fg", colors.mark[c.mark], _$p));
        return _el$41;
      })()
    }), _el$38);
    _$setProp(_el$38, "flexGrow", 1);
    _$insertNode(_el$39, _el$40);
    _$insert(_el$39, () => props.job.total, null);
    _$insert(_el$30, _$createComponent(For, {
      get each() {
        return groups();
      },
      children: group => {
        const shut = () => foldable(group.key) && folded().has(group.key);
        const count = () => foldable(group.key) ? `${group.count} ${shut() ? "▸" : "▾"}` : group.lines.length < group.count ? `${group.lines.length} of ${group.count}` : String(group.count);
        return (() => {
          var _el$43 = _$createElement("box"),
            _el$44 = _$createElement("box"),
            _el$45 = _$createElement("text"),
            _el$46 = _$createElement("box"),
            _el$47 = _$createElement("text");
          _$insertNode(_el$43, _el$44);
          _$setProp(_el$43, "paddingTop", 1);
          _$insertNode(_el$44, _el$45);
          _$insertNode(_el$44, _el$46);
          _$insertNode(_el$44, _el$47);
          _$setProp(_el$44, "flexDirection", "row");
          _$setProp(_el$44, "onMouseUp", () => foldable(group.key) && toggle(group.key));
          _$insert(_el$45, () => group.name);
          _$setProp(_el$46, "flexGrow", 1);
          _$insert(_el$47, count);
          _$insert(_el$43, _$createComponent(For, {
            get each() {
              return _$memo(() => !!shut())() ? [] : group.lines;
            },
            children: line => {
              const key = `${props.job.id}/${line.id}`;
              const open = () => grown().has(key);
              const sub = () => taskSessions(line.sessions ?? [], props.facts, props.live);
              return (() => {
                var _el$48 = _$createElement("box"),
                  _el$49 = _$createElement("box"),
                  _el$50 = _$createElement("text"),
                  _el$51 = _$createTextNode(` `),
                  _el$52 = _$createElement("text"),
                  _el$53 = _$createElement("box");
                _$insertNode(_el$48, _el$49);
                _$insertNode(_el$49, _el$50);
                _$insertNode(_el$49, _el$52);
                _$insertNode(_el$49, _el$53);
                _$setProp(_el$49, "flexDirection", "row");
                _$setProp(_el$49, "onMouseUp", () => line.sessions?.length && grow(key));
                _$insertNode(_el$50, _el$51);
                _$insert(_el$50, () => BOX[line.mark], _el$51);
                _$insert(_el$52, () => cut(`${line.id} ${line.title}`, line.detail ? 24 : 32));
                _$setProp(_el$53, "flexGrow", 1);
                _$insert(_el$49, _$createComponent(Show, {
                  get when() {
                    return line.detail;
                  },
                  get children() {
                    var _el$54 = _$createElement("text");
                    _$insert(_el$54, () => line.detail);
                    _$effect(_$p => _$setProp(_el$54, "fg", colors.muted, _$p));
                    return _el$54;
                  }
                }), null);
                _$insert(_el$49, _$createComponent(Show, {
                  get when() {
                    return line.sessions?.length;
                  },
                  get children() {
                    var _el$55 = _$createElement("text");
                    _$insert(_el$55, () => open() ? " ▾" : " ▸");
                    _$effect(_$p => _$setProp(_el$55, "fg", colors.muted, _$p));
                    return _el$55;
                  }
                }), null);
                _$insert(_el$48, _$createComponent(Show, {
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
                        var _el$56 = _$createElement("text");
                        _$insert(_el$56, () => `    +${sub().hidden} more`);
                        _$effect(_$p => _$setProp(_el$56, "fg", colors.muted, _$p));
                        return _el$56;
                      }
                    })];
                  }
                }), null);
                _$effect(_p$ => {
                  var _v$0 = colors.mark[line.mark],
                    _v$1 = line.mark === "open" || line.mark === "done" || line.mark === "dropped" ? colors.muted : colors.base;
                  _v$0 !== _p$.e && (_p$.e = _$setProp(_el$50, "fg", _v$0, _p$.e));
                  _v$1 !== _p$.t && (_p$.t = _$setProp(_el$52, "fg", _v$1, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$48;
              })();
            }
          }), null);
          _$effect(_p$ => {
            var _v$8 = colors.base,
              _v$9 = colors.muted;
            _v$8 !== _p$.e && (_p$.e = _$setProp(_el$45, "fg", _v$8, _p$.e));
            _v$9 !== _p$.t && (_p$.t = _$setProp(_el$47, "fg", _v$9, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$43;
        })();
      }
    }), null);
    _$effect(_p$ => {
      var _v$5 = colors.base,
        _v$6 = colors.muted,
        _v$7 = colors.muted;
      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$32, "fg", _v$5, _p$.e));
      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$34, "fg", _v$6, _p$.t));
      _v$7 !== _p$.a && (_p$.a = _$setProp(_el$39, "fg", _v$7, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$30;
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
    var _el$57 = _$createElement("box");
    _$insert(_el$57, _$createComponent(For, {
      get each() {
        return asks();
      },
      children: what => (() => {
        var _el$58 = _$createElement("box"),
          _el$59 = _$createElement("text"),
          _el$61 = _$createElement("text");
        _$insertNode(_el$58, _el$59);
        _$insertNode(_el$58, _el$61);
        _$setProp(_el$58, "flexDirection", "row");
        _$setProp(_el$58, "paddingBottom", 1);
        _$insertNode(_el$59, _$createTextNode(`[?] `));
        _$insert(_el$61, () => cut(`asks you: ${what}`, 34));
        _$effect(_p$ => {
          var _v$10 = colors.mark.waiting,
            _v$11 = colors.base;
          _v$10 !== _p$.e && (_p$.e = _$setProp(_el$59, "fg", _v$10, _p$.e));
          _v$11 !== _p$.t && (_p$.t = _$setProp(_el$61, "fg", _v$11, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$58;
      })()
    }), null);
    _$insert(_el$57, _$createComponent(Show, {
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
    _$insert(_el$57, _$createComponent(For, {
      get each() {
        return split().others;
      },
      children: job => (() => {
        var _el$62 = _$createElement("box"),
          _el$63 = _$createElement("box"),
          _el$64 = _$createElement("text"),
          _el$65 = _$createElement("box"),
          _el$66 = _$createElement("text");
        _$insertNode(_el$62, _el$63);
        _$setProp(_el$62, "paddingTop", 1);
        _$insertNode(_el$63, _el$64);
        _$insertNode(_el$63, _el$65);
        _$insertNode(_el$63, _el$66);
        _$setProp(_el$63, "flexDirection", "row");
        _$setProp(_el$63, "onMouseUp", () => flip(job.id));
        _$insert(_el$64, () => foldedLine(job));
        _$setProp(_el$65, "flexGrow", 1);
        _$insert(_el$66, () => opened().has(job.id) ? "▾" : "▸");
        _$insert(_el$62, _$createComponent(Show, {
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
          _v$12 !== _p$.e && (_p$.e = _$setProp(_el$64, "fg", _v$12, _p$.e));
          _v$13 !== _p$.t && (_p$.t = _$setProp(_el$66, "fg", _v$13, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$62;
      })()
    }), null);
    return _el$57;
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
      var _el$67 = _$createElement("box"),
        _el$68 = _$createElement("box"),
        _el$69 = _$createElement("text"),
        _el$71 = _$createElement("box"),
        _el$72 = _$createElement("text");
      _$insertNode(_el$67, _el$68);
      _$setProp(_el$67, "paddingTop", 1);
      _$insertNode(_el$68, _el$69);
      _$insertNode(_el$68, _el$71);
      _$insertNode(_el$68, _el$72);
      _$setProp(_el$68, "flexDirection", "row");
      _$setProp(_el$68, "onMouseUp", () => setOpen(!open()));
      _$insertNode(_el$69, _$createTextNode(`CONTEXT`));
      _$setProp(_el$71, "flexGrow", 1);
      _$insert(_el$72, () => open() ? "▾" : "▸");
      _$insert(_el$67, _$createComponent(Show, {
        get when() {
          return open();
        },
        get fallback() {
          return (() => {
            var _el$75 = _$createElement("text");
            _$insert(_el$75, () => cut(foldedContext(status(), mem()), 36));
            _$effect(_$p => _$setProp(_el$75, "fg", colors.muted, _$p));
            return _el$75;
          })();
        },
        get children() {
          return [_$createComponent(Show, {
            get when() {
              return status();
            },
            children: s => (() => {
              var _el$76 = _$createElement("box"),
                _el$77 = _$createElement("box"),
                _el$78 = _$createElement("text"),
                _el$79 = _$createElement("box"),
                _el$80 = _$createElement("text"),
                _el$81 = _$createTextNode(`/`),
                _el$82 = _$createElement("text");
              _$insertNode(_el$76, _el$77);
              _$insertNode(_el$76, _el$82);
              _$insertNode(_el$77, _el$78);
              _$insertNode(_el$77, _el$79);
              _$insertNode(_el$77, _el$80);
              _$setProp(_el$77, "flexDirection", "row");
              _$insert(_el$78, () => bar(s().tokens, s().ceiling, s().summaryAt, 22));
              _$setProp(_el$79, "flexGrow", 1);
              _$insertNode(_el$80, _el$81);
              _$insert(_el$80, () => kTokens(s().tokens), _el$81);
              _$insert(_el$80, () => kTokens(s().ceiling), null);
              _$insert(_el$82, () => cut(`epochs ${s().epochs} · pruned ${kTokens(s().savedChars)} chars · ${s().pending} waiting`, 36));
              _$effect(_p$ => {
                var _v$16 = full(s()) ? colors.mark.waiting : colors.mark.running,
                  _v$17 = colors.muted,
                  _v$18 = colors.muted;
                _v$16 !== _p$.e && (_p$.e = _$setProp(_el$78, "fg", _v$16, _p$.e));
                _v$17 !== _p$.t && (_p$.t = _$setProp(_el$80, "fg", _v$17, _p$.t));
                _v$18 !== _p$.a && (_p$.a = _$setProp(_el$82, "fg", _v$18, _p$.a));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined
              });
              return _el$76;
            })()
          }), _$createComponent(Show, {
            get when() {
              return mem();
            },
            children: m => (() => {
              var _el$83 = _$createElement("box"),
                _el$84 = _$createElement("text");
              _$insertNode(_el$83, _el$84);
              _$insert(_el$84, () => cut(`memory ${m().entries} · core ${kTokens(m().coreChars)} · ${m().vectors ? "● vectors" : "○ keywords"}`, 36));
              _$insert(_el$83, _$createComponent(Show, {
                get when() {
                  return m().writes.added || m().writes.duplicate || m().writes.contradicts;
                },
                get children() {
                  var _el$85 = _$createElement("text");
                  _$insert(_el$85, () => cut(`today +${m().writes.added} · ${m().writes.duplicate} dupes${m().writes.contradicts ? ` · ${m().writes.contradicts} ⚡ conflict` : ""}`, 36));
                  _$effect(_$p => _$setProp(_el$85, "fg", m().writes.contradicts ? colors.mark.waiting : colors.muted, _$p));
                  return _el$85;
                }
              }), null);
              _$effect(_$p => _$setProp(_el$84, "fg", colors.muted, _$p));
              return _el$83;
            })()
          }), _$createComponent(Show, {
            get when() {
              return status()?.recalled?.length;
            },
            get children() {
              return [(() => {
                var _el$73 = _$createElement("text");
                _$insertNode(_el$73, _$createTextNode(`recalled`));
                _$effect(_$p => _$setProp(_el$73, "fg", colors.base, _$p));
                return _el$73;
              })(), _$createComponent(For, {
                get each() {
                  return (status()?.recalled ?? []).slice(0, 3);
                },
                children: note => (() => {
                  var _el$86 = _$createElement("text");
                  _$insert(_el$86, () => cut(`· ${note}`, 36));
                  _$effect(_$p => _$setProp(_el$86, "fg", colors.muted, _$p));
                  return _el$86;
                })()
              })];
            }
          })];
        }
      }), null);
      _$effect(_p$ => {
        var _v$14 = colors.base,
          _v$15 = colors.muted;
        _v$14 !== _p$.e && (_p$.e = _$setProp(_el$69, "fg", _v$14, _p$.e));
        _v$15 !== _p$.t && (_p$.t = _$setProp(_el$72, "fg", _v$15, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$67;
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
    var _el$87 = _$createElement("box"),
      _el$88 = _$createElement("text"),
      _el$89 = _$createElement("text"),
      _el$90 = _$createElement("box"),
      _el$91 = _$createElement("text");
    _$insertNode(_el$87, _el$88);
    _$insertNode(_el$87, _el$89);
    _$insertNode(_el$87, _el$90);
    _$insertNode(_el$87, _el$91);
    _$setProp(_el$87, "flexDirection", "row");
    _$setProp(_el$87, "onMouseUp", onClick);
    _$insert(_el$88, () => name.padEnd(13));
    _$insert(_el$89, () => cut(models, 20));
    _$setProp(_el$90, "flexGrow", 1);
    _$insert(_el$91, mark);
    _$effect(_p$ => {
      var _v$19 = colors.base,
        _v$20 = colors.muted,
        _v$21 = colors.mark.running;
      _v$19 !== _p$.e && (_p$.e = _$setProp(_el$88, "fg", _v$19, _p$.e));
      _v$20 !== _p$.t && (_p$.t = _$setProp(_el$89, "fg", _v$20, _p$.t));
      _v$21 !== _p$.a && (_p$.a = _$setProp(_el$91, "fg", _v$21, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$87;
  })();
  return (() => {
    var _el$92 = _$createElement("box"),
      _el$93 = _$createElement("box"),
      _el$94 = _$createElement("text"),
      _el$96 = _$createElement("box"),
      _el$97 = _$createElement("text");
    _$insertNode(_el$92, _el$93);
    _$setProp(_el$92, "paddingTop", 1);
    _$insertNode(_el$93, _el$94);
    _$insertNode(_el$93, _el$96);
    _$insertNode(_el$93, _el$97);
    _$setProp(_el$93, "flexDirection", "row");
    _$setProp(_el$93, "onMouseUp", () => setOpen(!open()));
    _$insertNode(_el$94, _$createTextNode(`MODELS`));
    _$setProp(_el$96, "flexGrow", 1);
    _$insert(_el$97, () => open() ? "/pools ▾" : "/pools ▸");
    _$insert(_el$92, _$createComponent(Show, {
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
      _v$22 !== _p$.e && (_p$.e = _$setProp(_el$94, "fg", _v$22, _p$.e));
      _v$23 !== _p$.t && (_p$.t = _$setProp(_el$97, "fg", _v$23, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$92;
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
    var _el$98 = _$createElement("box"),
      _el$99 = _$createElement("box"),
      _el$100 = _$createElement("text"),
      _el$102 = _$createElement("box"),
      _el$103 = _$createElement("text"),
      _el$104 = _$createElement("box"),
      _el$105 = _$createElement("text");
    _$insertNode(_el$98, _el$99);
    _$insertNode(_el$98, _el$104);
    _$setProp(_el$98, "paddingLeft", 1);
    _$setProp(_el$98, "paddingRight", 1);
    _$insertNode(_el$99, _el$100);
    _$insertNode(_el$99, _el$102);
    _$insertNode(_el$99, _el$103);
    _$setProp(_el$99, "flexDirection", "row");
    _$insertNode(_el$100, _$createTextNode(`Agents`));
    _$setProp(_el$102, "flexGrow", 1);
    _$insert(_el$103, () => agentSummary(rows()));
    _$insert(_el$98, _$createComponent(For, {
      get each() {
        return rows();
      },
      children: (row, i) => (() => {
        var _el$107 = _$createElement("box"),
          _el$108 = _$createElement("text"),
          _el$109 = _$createElement("text"),
          _el$110 = _$createTextNode(` `),
          _el$111 = _$createElement("text"),
          _el$112 = _$createElement("box"),
          _el$113 = _$createElement("text");
        _$insertNode(_el$107, _el$108);
        _$insertNode(_el$107, _el$109);
        _$insertNode(_el$107, _el$111);
        _$insertNode(_el$107, _el$112);
        _$insertNode(_el$107, _el$113);
        _$setProp(_el$107, "flexDirection", "row");
        _$setProp(_el$107, "onMouseUp", () => setAt(i()));
        _$insert(_el$108, () => i() === at() ? "› " : "  ");
        _$insertNode(_el$109, _el$110);
        _$insert(_el$109, () => row.depth ? "  " : "", _el$110);
        _$insert(_el$109, () => row.tag.padEnd(4), _el$110);
        _$insert(_el$111, () => cut(row.title, row.depth ? 38 : 44));
        _$setProp(_el$112, "flexGrow", 1);
        _$insert(_el$113, () => [row.agent, row.model, row.elapsed, asks().get(row.id)?.what ?? "", row.cost ? `$${row.cost.toFixed(2)}` : ""].filter(Boolean).join("  "));
        _$effect(_p$ => {
          var _v$27 = row.depth === 0 && i() > 0 ? 1 : 0,
            _v$28 = i() === at() ? colors.mark.running : colors.muted,
            _v$29 = colors.tag[row.tag],
            _v$30 = row.depth ? colors.base : colors.base,
            _v$31 = colors.muted;
          _v$27 !== _p$.e && (_p$.e = _$setProp(_el$107, "paddingTop", _v$27, _p$.e));
          _v$28 !== _p$.t && (_p$.t = _$setProp(_el$108, "fg", _v$28, _p$.t));
          _v$29 !== _p$.a && (_p$.a = _$setProp(_el$109, "fg", _v$29, _p$.a));
          _v$30 !== _p$.o && (_p$.o = _$setProp(_el$111, "fg", _v$30, _p$.o));
          _v$31 !== _p$.i && (_p$.i = _$setProp(_el$113, "fg", _v$31, _p$.i));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined
        });
        return _el$107;
      })()
    }), _el$104);
    _$insertNode(_el$104, _el$105);
    _$setProp(_el$104, "paddingTop", 1);
    _$insertNode(_el$105, _$createTextNode(`↑↓ move ↵ open x stop y/n answer esc close`));
    _$effect(_p$ => {
      var _v$24 = colors.base,
        _v$25 = colors.muted,
        _v$26 = colors.muted;
      _v$24 !== _p$.e && (_p$.e = _$setProp(_el$100, "fg", _v$24, _p$.e));
      _v$25 !== _p$.t && (_p$.t = _$setProp(_el$103, "fg", _v$25, _p$.t));
      _v$26 !== _p$.a && (_p$.a = _$setProp(_el$105, "fg", _v$26, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$98;
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
        var _el$114 = _$createElement("box");
        _$insert(_el$114, _$createComponent(Checklist, {
          context: context,
          get sessionID() {
            return input.sessionID;
          }
        }), null);
        _$insert(_el$114, _$createComponent(ContextSection, {
          context: context,
          get sessionID() {
            return input.sessionID;
          }
        }), null);
        _$insert(_el$114, _$createComponent(Pools, {
          context: context
        }), null);
        return _el$114;
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
        return null;
      }
    });
  }
});