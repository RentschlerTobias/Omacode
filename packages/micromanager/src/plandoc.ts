// The plan document (A1-T8): what a plan job writes down, and what Build mode reads before it starts at `execute` or
// decides it has to plan again. The headings are a contract, not decoration: the parser below reads exactly these, and
// the artifact contracts (B1-T6) will read them too, so a renamed heading is a changed format.
//
// The document always carries the same seven sections — goal, findings, decisions, open questions, recommended tasks,
// artifacts, risks — and, when A1-T7 applied, the line that says the job ran reader-only. An empty section says
// "(none)" rather than vanishing, so a reader can tell "nothing was found" from "the document was cut short".
//
// docFromJob is the document the plugin itself guarantees: the job's goal, decisions, tasks, promoted artifacts and
// lessons, in this shape, written where a plan job starts and rewritten when a task hands artifacts back. A plan agent
// may write a richer plan.md itself — that is its job — and the plugin leaves such a document alone (src/native.ts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { planArea } from "./worktree/git.ts"
import type { Job } from "./state.ts"

export interface PlanDoc {
  goal: string
  findings: string[]
  decisions: string[]
  openQuestions: string[]
  tasks: { id: string; title: string; role: string; files: string[]; acceptance: string[] }[]
  artifacts: { task: string; path: string; bytes: number; sha256: string }[]
  risks: string[]
  readerOnly?: string
}

// The heading text, once: the renderer and the parser read the same constants, so they cannot drift apart.
const HEADINGS = {
  goal: "Goal",
  findings: "Findings",
  decisions: "Decisions",
  openQuestions: "Open questions",
  tasks: "Recommended tasks",
  artifacts: "Artifacts",
  risks: "Risks",
} as const

const NONE = "(none)"
const BULLET = /^- /
const TASK_LINE = /^- \*\*(.*?)\*\* (.*?) · role (\S+) · files: (.*) · acceptance: (.*)$/
const ARTIFACT_LINE = /^- (.*?): (.*) \((\d+) B, sha256 ([0-9a-f]{64})\)$/
const MODE_LINE = /^\*\*Mode:\*\* reader-only(?: — ?(.*))?$/m

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// One comma-separated list inside a task bullet; "(none)" is how the renderer spells an empty one.
function listText(items: readonly string[]): string {
  return items.length ? items.join(", ") : NONE
}

function listOf(text: string): string[] {
  const t = text.trim()
  return !t || t === NONE ? [] : t.split(",").map((p) => p.trim()).filter(Boolean)
}

function heading(name: string, body: string): string[] {
  return [`## ${name}`, "", body, ""]
}

export function renderPlanDoc(job: Pick<Job, "id">, doc: PlanDoc): string {
  const lines = (items: readonly string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : NONE)
  const tasks = doc.tasks.length
    ? doc.tasks.map((t) => `- **${t.id}** ${t.title} · role ${t.role} · files: ${listText(t.files)} · acceptance: ${listText(t.acceptance)}`).join("\n")
    : NONE
  const artifacts = doc.artifacts.length
    ? doc.artifacts.map((a) => `- ${a.task}: ${a.path} (${a.bytes} B, sha256 ${a.sha256})`).join("\n")
    : NONE
  const mode = doc.readerOnly !== undefined ? [`**Mode:** reader-only — ${doc.readerOnly}`, ""] : []
  return [
    `# ${job.id} — plan`,
    "",
    ...mode,
    ...heading(HEADINGS.goal, doc.goal.trim() || NONE),
    ...heading(HEADINGS.findings, lines(doc.findings)),
    ...heading(HEADINGS.decisions, lines(doc.decisions)),
    ...heading(HEADINGS.openQuestions, lines(doc.openQuestions)),
    ...heading(HEADINGS.tasks, tasks),
    ...heading(HEADINGS.artifacts, artifacts),
    ...heading(HEADINGS.risks, lines(doc.risks)),
  ].join("\n").trimEnd() + "\n"
}

// The `## ` sections of a document, by heading, as their lines. A heading repeated later merges its lines into the
// first, which is the lenient reading: the document still says what it says.
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of text.split(/\r?\n/)) {
    const found = /^##\s+(.*?)\s*$/.exec(line)
    if (found) {
      const name = found[1]!
      current = out.get(name) ?? []
      out.set(name, current)
      continue
    }
    current?.push(line)
  }
  return out
}

// A section's lines without the blank padding the renderer puts around it.
function bodyLines(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]!.trim()) start++
  while (end > start && !lines[end - 1]!.trim()) end--
  return lines.slice(start, end)
}

// A section of bullets. A line that is not a bullet continues the one above it, so a wrapped finding survives; text
// without any bullet is read as one item, which is how a hand-written paragraph in the agent's own document parses.
function bullets(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of bodyLines(lines)) {
    if (BULLET.test(line)) out.push(line.slice(2))
    else if (!line.trim()) continue
    else if (out.length) out[out.length - 1] += `\n${line}`
    else out.push(line)
  }
  return out.length === 1 && out[0] === NONE ? [] : out
}

function tasksOf(lines: readonly string[], errors: string[]): PlanDoc["tasks"] {
  const body = bodyLines(lines)
  if (!body.length || (body.length === 1 && body[0] === NONE)) return []
  const out: PlanDoc["tasks"] = []
  for (const line of body) {
    const found = TASK_LINE.exec(line)
    if (!found) {
      errors.push(`a recommended task cannot be read: "${line}"`)
      continue
    }
    out.push({ id: found[1]!, title: found[2]!, role: found[3]!, files: listOf(found[4]!), acceptance: listOf(found[5]!) })
  }
  return out
}

function artifactsOf(lines: readonly string[], errors: string[]): PlanDoc["artifacts"] {
  const body = bodyLines(lines)
  if (!body.length || (body.length === 1 && body[0] === NONE)) return []
  const out: PlanDoc["artifacts"] = []
  for (const line of body) {
    const found = ARTIFACT_LINE.exec(line)
    if (!found) {
      errors.push(`an artifact cannot be read: "${line}"`)
      continue
    }
    out.push({ task: found[1]!, path: found[2]!, bytes: Number(found[3]!), sha256: found[4]! })
  }
  return out
}

// A document read back. A missing Goal or Recommended tasks heading is refused: the first is what the job is for, the
// second is what Build mode would start, and a file without them is not this contract's document.
export function parsePlanDoc(text: string): { doc?: PlanDoc; errors: string[] } {
  const errors: string[] = []
  const found = sections(text)
  const goal = found.get(HEADINGS.goal)
  const tasks = found.get(HEADINGS.tasks)
  if (!goal) errors.push(`the plan has no ## ${HEADINGS.goal} section`)
  if (!tasks) errors.push(`the plan has no ## ${HEADINGS.tasks} section`)
  if (errors.length || !goal || !tasks) return { errors }
  const mode = MODE_LINE.exec(text)
  const goalText = bodyLines(goal).join("\n")
  const doc: PlanDoc = {
    goal: goalText === NONE ? "" : goalText,
    findings: bullets(found.get(HEADINGS.findings) ?? []),
    decisions: bullets(found.get(HEADINGS.decisions) ?? []),
    openQuestions: bullets(found.get(HEADINGS.openQuestions) ?? []),
    tasks: tasksOf(tasks, errors),
    artifacts: artifactsOf(found.get(HEADINGS.artifacts) ?? [], errors),
    risks: bullets(found.get(HEADINGS.risks) ?? []),
    ...(mode ? { readerOnly: mode[1] ?? "" } : {}),
  }
  return errors.length ? { errors } : { doc, errors }
}

// Where the document lives: in the plan area, beside the worktrees, artifacts, findings and patches of the same job.
export function planDocPath(project: string, jobId: string): string {
  return join(planArea(project, jobId), "plan.md")
}

// Writes the document 0600 under a 0700 directory, like every other record of a plan job.
export function writePlanDoc(project: string, jobId: string, doc: PlanDoc): string {
  const path = planDocPath(project, jobId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, renderPlanDoc({ id: jobId }, doc), { mode: 0o600 })
  return path
}

export function readPlanDoc(project: string, jobId: string): { doc?: PlanDoc; errors: string[]; path: string } {
  const path = planDocPath(project, jobId)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT"
    return { errors: [missing ? "no plan.md yet" : `plan.md cannot be read: ${why(err)}`], path }
  }
  const parsed = parsePlanDoc(text)
  return parsed.doc ? { doc: parsed.doc, errors: parsed.errors, path } : { errors: parsed.errors, path }
}

// The document the plugin always guarantees, built from the job itself. A plan agent may write a richer document
// itself — findings it read, questions it has, tasks it recommends before they are `job.tasks`, a risk it noticed — and
// that one wins (src/native.ts keeps it and only replaces a missing or plugin-written document). This is the floor,
// not the ceiling. A cancelled task is left out: it is history, not a recommendation. The findings are the finished
// tasks' summary lines, the risks are the job's lessons, and the artifacts are exactly what the tasks promoted.
export function docFromJob(job: Job): PlanDoc {
  const tasks = job.tasks
    .filter((t) => t.status !== "cancelled")
    .map((t) => ({ id: t.id, title: t.title, role: t.role, files: [...t.files], acceptance: [...t.acceptance] }))
  const findings = job.tasks
    .filter((t) => t.status === "passed" || t.status === "merged")
    .map((t) => t.summary?.split("\n")[0]?.trim())
    .filter((line): line is string => Boolean(line))
  return {
    goal: job.goal,
    findings,
    decisions: job.decisions.map((d) => d.text),
    openQuestions: [],
    tasks,
    artifacts: job.tasks.flatMap((t) => (t.promoted ?? []).map((a) => ({ task: t.id, path: a.path, bytes: a.bytes, sha256: a.sha256 }))),
    risks: [...job.lessons],
    ...(job.planReaderOnly !== undefined ? { readerOnly: job.planReaderOnly } : {}),
  }
}
