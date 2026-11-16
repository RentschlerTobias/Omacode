// The two cloud questions a permission case asks besides decide()'s own three, in one place so their journal shape cannot
// drift apart (A2-T2b). Both used to call the raw client, which journalled nothing: the answer reached the decision and
// the inputs were gone. Through the decider, each case records the request, the text that was sent (redacted by the
// egress gate), the question and the answer — which is what a label factory and an eval need.
//
// The permission nodes are cloud-only (`cloudAnswers`): A2b exports their cases for the local model and measures it on
// them, but the gate has not passed and the routing has not flipped, so a local model would still be answering
// something nobody has checked.

import type { Decider } from "./backends.ts"
import { CHECK_BUG } from "./catalog.ts"
import { grantState, harmlessQuestion, type GrantKind } from "./grants.ts"

// Jev's opinion on whether a requested variable or host is harmless, as a probability. 0 when nothing answered: the
// caller then asks the user, exactly as it did before the ask existed.
export async function askGrantHarmless(
  decider: Decider,
  input: { readonly kind: GrantKind; readonly name: string; readonly why: string; readonly task: string; readonly value?: string; readonly session: string; readonly job: string },
): Promise<number> {
  const asked = await decider.ask("N13.grant", { text: grantState(input.kind, input.name, input.why, input.task, input.value) }, { harmless: harmlessQuestion(input.kind) }, {
    cloudAnswers: true,
    session: input.session,
    job: input.job,
    request: { kind: "grant", grant: input.kind, name: input.name, why: input.why.slice(0, 300), sessionID: input.session, job: input.job },
  })
  const answer = asked.decision.answers.harmless
  return answer?.type === "noul" ? answer.noul : 0
}

// Jev's opinion on a worker's claim that a failing check is itself wrong. 1 when nothing answered: the check stands,
// and the request goes on to whoever decides this kind of change.
export async function askCheckBug(
  decider: Decider,
  input: { readonly task: string; readonly target: string; readonly problem: string; readonly evidence: string; readonly session: string; readonly job: string; readonly taskId: string },
): Promise<number> {
  const state = `A worker's check failed and the worker says the check itself is wrong.\nTask: ${input.task}\nCheck: ${input.target}\nProblem: ${input.problem}\nEvidence: ${input.evidence.slice(0, 2000)}`
  const asked = await decider.ask("N13.check_bug", { text: state }, { check_bug: CHECK_BUG }, {
    cloudAnswers: true,
    session: input.session,
    job: input.job,
    request: { kind: "check_bug", target: input.target, problem: input.problem.slice(0, 300), sessionID: input.session, job: input.job, task: input.taskId },
  })
  const answer = asked.decision.answers.check_bug
  return answer?.type === "noul" ? answer.noul : 1
}
