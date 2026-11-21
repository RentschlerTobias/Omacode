// G0, the local-first gate (design.md §20, §21): three guards on a job's or task's text, answered on the machine —
// injection, harmful and sensitive. Cloud mode may take them to the cloud only for a session whose user said so
// (A2-T5); otherwise they stay local.
//
// Until our own GLiNER fine-tune passes the guard bench, a "yes" never routes or blocks on its own: it asks the user
// (Phase A9 showed the available fine-tune flags legitimate security work as harmful). The user's answer sets the
// job's flags: local only, uncensored allowed, or on as it is.

import type { Decider, DeciderMode } from "./backends.ts"
import { GUARD_FLOOR, GUARDS } from "./catalog.ts"

import type { GateResult, Guard, JobFlags } from "@omacode/state/schema"
export type { GateResult, Guard, JobFlags }

// A long text is read in windows (P6-T1b): one classification pools its whole input into one judgement, so a short
// injection at the end of a long harmless text was diluted to nothing (measured 2026-11-18 on gliner-guard: +6.1 logit
// at 700 characters, +0.3 at 8 000, nothing from 16 000), and before this the client sent only the last 2 000
// characters anyway. Windows of 1 500 characters overlap by 200, so a sentence cut at one edge is whole in the next;
// the highest score per guard counts, because one window that is an injection makes the text one. Past MAX_WINDOWS the
// rest is not read, and the result says how much was left out.
export const WINDOW = 1500
export const OVERLAP = 200
export const MAX_WINDOWS = 24

export function windows(text: string, size = WINDOW, overlap = OVERLAP, max = MAX_WINDOWS): { parts: string[]; unread: number } {
  if (text.length <= size) return { parts: [text], unread: 0 }
  const step = size - overlap
  const parts: string[] = []
  let at = 0
  for (; at < text.length && parts.length < max; at += step) {
    parts.push(text.slice(at, at + size))
    if (at + size >= text.length) return { parts, unread: 0 }
  }
  return { parts, unread: Math.max(0, text.length - (at - step + size)) }
}

// The same text scored 0.59 and 2e-8 for injection in two runs of Phase D, so every text is scored twice and the
// higher score counts: a guard errs towards asking the user. Each window is scored that way.
export async function checkGuards(decider: Decider, text: string, job?: string, task?: string, repeats = 2, session?: string): Promise<GateResult> {
  const scores: Partial<Record<Guard, number>> = {}
  let checked = false
  let decision: string | undefined
  const { parts, unread } = windows(text)
  for (const part of parts) {
    for (let i = 0; i < repeats; i++) {
      const asked = await decider.ask("G0", { text: part }, GUARDS, { job, task, ...(session ? { session } : {}) })
      decision ??= asked.id
      for (const g of Object.keys(GUARDS) as Guard[]) {
        const a = asked.decision.answers[g]
        if (a?.type === "noul") scores[g] = Math.max(scores[g] ?? 0, a.noul)
      }
      checked ||= asked.backend !== "rules" && Object.keys(asked.decision.answers).length > 0
    }
  }
  return { flagged: (Object.keys(scores) as Guard[]).filter((g) => scores[g]! >= GUARD_FLOOR), scores, checked, decision, ...(unread ? { unread } : {}) }
}

// Indirect injection (E2b): text a worker did not write but reads (web pages, research notes, a worker's question)
// is checked for injection alone, in the same windows, since an injection can hide anywhere in a long page. Returns
// the highest score, or undefined when nothing local answered.
//
// It runs on every tool result a worker reads, so its windows are capped lower: GLiNER2.5 takes about 1.6 s per window
// on the CPU (measured 2026-11-21), and 24 windows would hold a worker up for 38 s per web page. Seven windows read
// what the old six chunks did (about 9 000 characters), now with the overlap. The successor (gliner-guard, about 0.2 s
// per window) lets this rise to MAX_WINDOWS.
export const INJECTION_WINDOWS = 7

export async function injectionScore(decider: Decider, text: string, job?: string, task?: string, session?: string): Promise<number | undefined> {
  let best: number | undefined
  for (const part of windows(text, WINDOW, OVERLAP, INJECTION_WINDOWS).parts) {
    const asked = await decider.ask("G0.injection", { text: part }, { injection: GUARDS.injection }, { job, task, ...(session ? { session } : {}) })
    const a = asked.decision.answers.injection
    if (asked.backend !== "rules" && a?.type === "noul") best = Math.max(best ?? 0, a.noul)
  }
  return best
}

export const injected = (score: number | undefined): boolean => (score ?? 0) >= GUARD_FLOOR

// What the job does when nothing local could check it. "local" is the privacy-first default (user, 2026-10-04).
export type Unchecked = "local" | "user" | "cloud"

// mode "cloud": sensitive only chooses local models, and there are none; only injection and harmful ask the user.
// (The cloud Jev on the guard bench, 2026-10-05: injection and harmful 100 % recall with 0 % false alarms, sensitive a
// false alarm on 92 % of harmless cases.)
export function flagsWithoutUser(result: GateResult, unchecked: Unchecked = "local", mode: DeciderMode = "local"): JobFlags | "ask_user" {
  if (!result.checked) return unchecked === "user" ? "ask_user" : { localOnly: unchecked === "local", gate: result }
  const asks = mode === "cloud" ? result.flagged.filter((g) => g === "injection" || g === "harmful") : result.flagged
  return asks.length === 0 ? { gate: result } : "ask_user"
}

// The question the micromanager puts to the user when the gate flagged something.
export function gateQuestion(result: GateResult, mode: DeciderMode = "local"): string {
  const what: Record<Guard, string> = {
    injection: "the text may try to change the agents' rules (injection)",
    harmful: "it may ask for help to harm people or attack systems you do not own",
    sensitive: "it may hold data that should stay on this machine",
  }
  const lines = result.flagged.map((g) => `- ${what[g]} (${(result.scores[g] ?? 0).toFixed(2)})`)
  return [
    "The local check flagged this job:",
    ...lines,
    "The check is not calibrated yet, so you decide. Answer with one of:",
    ...(mode === "cloud"
      ? ['"continue" (go on as normal, in the cloud) or "stop". Local models are switched off for now.']
      : ['"always local" (keep everything on this machine), "use uncensored" (local uncensored models only),', '"continue" (go on as normal), or "stop".']),
  ].join("\n")
}

// The user's answer to the gate question; exact phrases, matched before any model.
export function gateAnswer(text: string): JobFlags | "stop" | undefined {
  const t = text.trim().toLowerCase().replace(/[.!"]+$/g, "").replace(/^"/, "")
  if (t === "always local" || t === "only local") return { localOnly: true }
  if (t === "use uncensored" || t === "uncensored") return { localOnly: true, uncensored: true }
  if (t === "continue" || t === "go on") return {}
  if (t === "stop") return "stop"
  return undefined
}
