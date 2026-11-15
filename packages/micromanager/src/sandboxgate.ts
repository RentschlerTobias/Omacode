// The one question of D23 (A1-T14). A1 made plan mode and the task gate fail closed, which on a machine where no
// sandbox can run means no build task ever passes and the plugin cannot do its job. D23: the job's commands and checks
// then run unwrapped only after the user confirmed it for that job, with a deterministic risk score in front of them
// (src/riskscore.ts). The user's decision, never the micromanager's word, opens the grant.
//
// The plugin cannot open a form itself (src/forms.ts: its context has no form domain), so this file makes the decision
// and the exact form the micromanager passes to the question tool. The answer comes back through tool.execute.after as
// the form's labels, which src/plugin.ts reads and journals with the score.

import { askAnswer } from "./ask.ts"
import type { Question } from "./forms.ts"
import { scoreCommands, type RiskScore } from "./riskscore.ts"

export type GateDecision =
  | { readonly kind: "run"; readonly unsandboxed: boolean }
  | { readonly kind: "ask"; readonly text: string; readonly score: RiskScore }
  | { readonly kind: "refuse"; readonly text: string }

export interface SandboxInput {
  readonly available: boolean // whether a sandbox can run here at all
  readonly setting: "ask" | "never" | "allow" // the "unsandboxed" config setting
  readonly granted: boolean // this job's own grant, in its control file
  readonly reason?: string // why no sandbox can run, as the machine reported it
  readonly jobId: string
  readonly checks: readonly string[] // the job's checks: what the score reads
  readonly plan: boolean // a plan job: untrusted worktree, so the score is higher
}

// What the job may do here. Only this function decides; a caller can store the answer but never make one up.
export function sandboxDecision(input: SandboxInput): GateDecision {
  if (input.available) return { kind: "run", unsandboxed: false }
  const why = input.reason ? ` (${input.reason})` : ""
  if (input.setting === "never") {
    return {
      kind: "refuse",
      text:
        `Not started: there is no sandbox on this machine${why}, and "${input.jobId}" may not run without one (the "unsandboxed" setting is "never"). ` +
        `Fix the sandbox first (omacode doctor); only then do its commands and checks run.`,
    }
  }
  // The config's standing word, or this job's own grant: both mean the user already decided, and the caller journals
  // which of the two this was.
  if (input.setting === "allow" || input.granted) return { kind: "run", unsandboxed: true }
  const score = scoreCommands(input.checks, { plan: input.plan })
  return { kind: "ask", score, text: askText(input, score, why) }
}

// What the micromanager is told before it asks: the score, one line per finding, the check lines, and the sentence that
// keeps the number from being read as a promise.
function askText(input: SandboxInput, score: RiskScore, why: string): string {
  const lines = score.findings.map((f) => `- ${f.what} (+${f.weight})`)
  const shown = input.checks.slice(0, 10).map((c) => `- ${c}`)
  const rest = input.checks.length > 10 ? [`… and ${input.checks.length - 10} more`] : []
  return [
    `No sandbox can run on this machine${why}, so job ${input.jobId} would run its commands and checks with the user's own rights. Nothing starts until the user says so for this job.`,
    `Risk ${score.band}: ${score.score}/100.`,
    ...(score.findings.length ? lines : ["- nothing the score knows: its commands are ordinary writes and tests"]),
    input.checks.length ? `Checks:\n${[...shown, ...rest].join("\n")}` : "This job has no checks yet.",
    "The score reads the command text rather than what a program does, so it is a help and not a guarantee.",
  ].join("\n")
}

// The header the plugin recognises the answer by (src/forms.ts: a form is known by its headers).
export const SANDBOX_FORM_HEADER = "No sandbox"

const START = "Start without a sandbox"
const READ_ONLY = "Run read-only"
const CANCEL = "Cancel"

export function sandboxForm(decision: { jobId: string; reason?: string; score: RiskScore; checks: readonly string[] }): Question[] {
  const why = decision.reason ? ` (${decision.reason})` : ""
  const findings = decision.score.findings.map((f) => `${f.rule} (+${f.weight})`).join(", ")
  const checks = decision.checks.length === 1 ? "1 check" : `${decision.checks.length} checks`
  return [{
    header: SANDBOX_FORM_HEADER,
    question:
      `No sandbox can run on this machine${why}, so job ${decision.jobId}'s commands and ${checks} would run with your rights. ` +
      `Risk ${decision.score.band}: ${decision.score.score}/100${findings ? ` (${findings})` : ""}. What should happen?`,
    options: [
      { label: START, description: `The job's commands and checks run with your rights, unwrapped (risk ${decision.score.band} ${decision.score.score}/100)` },
      { label: READ_ONLY, description: "Nothing of the project is touched and no check runs" },
      { label: CANCEL, description: "Nothing starts" },
    ],
  }]
}

// What the user's answer on the sandbox form means. The plugin's labels open the grant; a short answer people type
// themselves ("yes", "no") is taken the same way, and anything else is no answer at all.
export function sandboxAnswer(labels: readonly string[]): "allow" | "read-only" | "cancel" | undefined {
  for (const label of labels) {
    const said = label.trim().toLowerCase().replace(/\s*\(recommended\)\s*$/, "").replace(/\s+/g, " ")
    if (said === START.toLowerCase()) return "allow"
    if (said === READ_ONLY.toLowerCase()) return "read-only"
    if (said === CANCEL.toLowerCase()) return "cancel"
    if (["read only", "readonly"].includes(said)) return "read-only"
    const answer = askAnswer(label)
    if (answer === "once" || answer === "job") return "allow"
    if (answer === "refuse") return "cancel"
  }
  return undefined
}

// The grant the user's answer (or the config's "allow") puts on record: the job's control file and the journal, in one
// place so both carry the score the form showed. The caller passes the two writers, so this is testable without the
// plugin's closure; the plugin passes `updateControl` and `record`.
export interface GrantInput {
  readonly project: string
  readonly jobId: string
  readonly score: RiskScore
  readonly by: "config" | "user"
  readonly control: (project: string, jobId: string, patch: {
    readonly unsandboxed: {
      readonly granted: true
      readonly at: string
      readonly by: "config" | "user"
      readonly score: number
      readonly band: string
      readonly findings: readonly string[]
    }
  }) => void
  readonly journal: (entry: Record<string, unknown>) => void
}

export function writeUnsandboxedGrant(input: GrantInput): void {
  const findings = input.score.findings.map((f) => f.what)
  const grant = { granted: true as const, at: new Date().toISOString(), by: input.by, score: input.score.score, band: input.score.band, findings }
  input.control(input.project, input.jobId, { unsandboxed: grant })
  input.journal({ kind: "sandbox.override", project: input.project, jobId: input.jobId, granted: true, by: input.by, score: input.score.score, band: input.score.band, findings })
}
