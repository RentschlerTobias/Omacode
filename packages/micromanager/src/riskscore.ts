// A deterministic risk score for the commands of a job (D23, A1-T14). When no sandbox can run on the machine, the user
// is asked before a job's commands and checks run with their own rights; the form shows this score, its findings and the
// check lines first (src/sandboxgate.ts). The score is arithmetic over the command text and nothing else: no model call,
// no state, so two runs of the same text give the same number and the number can be shown before anything starts.
//
// It is a help and not a guarantee, in the same words the form uses: it reads what a command says, not what the program
// it starts ends up doing. A check that is one word long can do anything, and a `make` that looks plain can delete a
// directory, which is why the user's answer, not this number, is what opens a job.

import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

export interface RiskFinding {
  readonly rule: string
  readonly weight: number
  readonly what: string
}

export interface RiskScore {
  readonly score: number
  readonly band: "low" | "medium" | "high"
  readonly findings: readonly RiskFinding[]
}

interface Rule {
  readonly rule: string
  readonly weight: number
  readonly what: string
  readonly test: (command: string) => boolean
}

const has = (pattern: RegExp) => (command: string) => pattern.test(command)

// The weights are D23's: one rule that is bad on its own sets the score, the others add a third of their weight, so a
// command that is destructive and privileged is worse than one that is only destructive. Plain builds and tests weigh
// nothing: they are what a check usually is, and naming them keeps the list complete instead of silent.
const RULES: readonly Rule[] = [
  {
    rule: "destructive",
    weight: 40,
    what: "destructive: deletes or overwrites without asking (rm -rf, rm -fr, dd, mkfs, chmod -R, chown -R, a disk device, a fork bomb)",
    test: has(/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b|\bdd\s+(?:if|of|bs|count)=|\bmkfs(?:\.[a-z0-9]+)?\b|\bchmod\s+-[rR]\b|\bchown\s+-[rR]\b|>\s*\/dev\/[sh]d|:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/),
  },
  {
    rule: "privilege",
    weight: 35,
    what: "privilege: runs as root or as another user (sudo, doas, pkexec, su -)",
    test: has(/\b(?:sudo|doas|pkexec)\b|\bsu\s+-/),
  },
  {
    rule: "keys-secrets",
    weight: 30,
    what: "keys/secrets: reads key material, credentials or an env file (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, id_rsa, .env)",
    test: has(/~\/\.(?:ssh|aws|gnupg)\b|~\/\.config\/gh\b|(?:^|[\s"'`=/])\.env\b|\bid_(?:rsa|ed25519)\b/),
  },
  {
    rule: "network-execute",
    weight: 20,
    what: "network-execute: downloads and runs code (curl | sh, wget | sh, npx, pip install, npm i -g)",
    test: has(/\b(?:curl|wget)\b[^|;\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b|\bnpx\b|\bpip[0-9.]*\s+install\b|\bnpm\s+(?:i|install)\s+(?:-g|--global)\b/),
  },
  {
    rule: "obfuscation",
    weight: 20,
    what: "obfuscation: hides what it runs (base64 -d, eval, node -e with child_process)",
    test: has(/\bbase64\s+(?:-d|--decode)\b|\beval\b|\bnode\s+(?:-e|--eval)\b[^\n]*child_process/),
  },
  {
    rule: "writes-outside",
    weight: 15,
    what: "writes outside the project: absolute paths away from it, or .. climbing out",
    test: outside,
  },
  {
    rule: "git-refs",
    weight: 15,
    what: "git ref moves: push, reset --hard, clean -fdx, checkout -- .",
    test: has(/\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*x|clean\s+-[a-zA-Z]*d[a-zA-Z]*f[a-zA-Z]*x|checkout\s+--\s+\.)\b/),
  },
  {
    rule: "plain-build",
    weight: 0,
    what: "plain build or test: the usual command of a check (npm test, npm run, pytest, tsc, cargo test, go test)",
    test: has(/(?:^|[;&|]\s*)(?:npm\s+(?:test|run|t)\b|pytest\b|cargo\s+test\b|go\s+test\b)|\btsc\b/),
  },
]

// A token that names a path outside the project: an absolute path (or one under ~) that is not the project, its
// subdirectories or the temp directory, or a token that climbs with "..". The project is the process's directory: the
// score takes no project argument on purpose (a pure function of the command text and where the plugin runs), and a
// check that names another checkout is exactly what this rule is about.
function outside(command: string): boolean {
  const root = resolve(process.cwd())
  const temp = resolve(tmpdir())
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^["'`([{,]+/, "").replace(/["'`)\]}.,;:]+$/, "")
    if (!token) continue
    if (/(^|\/)\.\.(\/|$)/.test(token)) return true
    if (token.includes("://")) continue // a URL is network-execute's business, not a write here
    const path = token.startsWith("~/") ? join(homedir(), token.slice(2)) : token
    if (!path.startsWith("/")) continue
    const abs = resolve(path)
    if (abs === root || abs.startsWith(`${root}/`)) continue
    if (abs === temp || abs.startsWith(`${temp}/`)) continue
    return true
  }
  return false
}

// The band follows the worst rule before the number: a destructive, privileged or key-reading command is high whatever
// the arithmetic says, because the score is there to rank a list, not to reassure. The threshold only catches
// combinations of lesser rules (a build plus a network call, say).
function bandOf(score: number, findings: readonly RiskFinding[]): RiskScore["band"] {
  const worst = findings.reduce((w, f) => Math.max(w, f.weight), 0)
  if (worst >= 30) return "high"
  if (worst >= 15 || score >= 20) return "medium"
  return "low"
}

// No commands (or none with text): nothing to weigh, so nothing is claimed about it.
const NOTHING: RiskScore = { score: 0, band: "low", findings: [] }

export function scoreCommands(commands: readonly string[], opts?: { readonly plan?: boolean }): RiskScore {
  const text = commands.filter((c) => c.trim())
  if (text.length === 0) return NOTHING
  const matched = RULES.map((rule, at) => ({ rule, at })).filter(({ rule }) => text.some((c) => rule.test(c)))
  // One finding per rule, in weight order: the worst first, which is the one the score is built around.
  const findings: RiskFinding[] = matched
    .sort((a, b) => b.rule.weight - a.rule.weight || a.at - b.at)
    .map(({ rule }) => ({ rule: rule.rule, weight: rule.weight, what: rule.what }))
  const weights = findings.map((f) => f.weight)
  const max = weights.length ? Math.max(...weights) : 0
  const total = weights.reduce((sum, w) => sum + w, 0)
  const plan = opts?.plan === true
  // A plan job's checks are written by an investigator and promoted from a worktree that nobody has inspected yet, so
  // the same text is worth more there. The bonus is flat: it says why the job starts above the command itself.
  const score = Math.min(100, max + Math.floor((total - max) / 3) + (plan ? 15 : 0))
  if (plan) findings.push({ rule: "plan", weight: 15, what: "a plan job's checks come from an untrusted worktree (+15)" })
  // The plan finding is named where its weight belongs, so the list stays in weight order after the addition.
  const ordered = [...findings].sort((a, b) => b.weight - a.weight)
  return { score, band: bandOf(score, ordered), findings: ordered }
}
