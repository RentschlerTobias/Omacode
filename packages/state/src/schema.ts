// The schema of a job: the shapes the store, the TUI and the runner exchange.
// Runtime code lives elsewhere; this file only defines the contract.

export type RoleId =
  | "explore"
  | "research"
  | "plan"
  | "code"
  | "test"
  | "visual"
  | "write"
  | "debug"
  | "review"
  | "oracle"

export const RISKS = {
  cosmetic: "only looks or wording change; nothing can break",
  internal: "internal code; callers inside the project may break",
  public_api: "an interface others use: exported functions, CLI flags, file formats, HTTP endpoints",
  data_security: "touches user data, credentials, permissions or anything security relevant",
  destructive: "deletes or overwrites data, or has effects outside the project (deploys, sends, publishes)",
} as const
export type Risk = keyof typeof RISKS

export type PermProfile = "strict" | "normal" | "trusted"
export type BudgetTier = "S" | "M" | "L"
export type ToolGroup = "shell" | "web"

export type PolicySet = Readonly<Record<string, string>> // key -> "auto" | "ask" | "rule" | "fixed:<value>"

export type Guard = "injection" | "harmful" | "refusal_likely" | "sensitive"
export interface GateResult {
  readonly flagged: readonly Guard[]
  readonly scores: Partial<Record<Guard, number>>
  readonly checked: boolean
  readonly decision?: string
}
export interface JobFlags {
  localOnly?: boolean
  uncensored?: boolean
  gate?: GateResult
}

export interface Profile {
  readonly role: string
  readonly roleReason: string
  readonly difficulty: number
  readonly risk: Risk
  readonly testOracle: boolean
  readonly testFirst: boolean
  readonly bugFix: boolean
  readonly approachUncertain: boolean
  readonly bugUnknownCause: boolean
  readonly vision: boolean
  readonly tools: Readonly<Record<ToolGroup, number | undefined>>
  readonly skills: readonly string[]
  readonly perm: PermProfile
  readonly budget: BudgetTier
  readonly injection: boolean
  readonly confidence: number
  readonly source: "model" | "rules"
  readonly decision?: string
  readonly recall?: readonly string[]
  confirmed?: boolean
}

export type Impact = "low" | "medium" | "high"
export type NodeKind = "decision" | "fact" | "assumption"
export type NodeStatus = "open" | "settled" | "assumed" | "out_of_scope" | "researching"
export type Depth = "light" | "normal" | "frequent"

export interface DesignNode {
  readonly id: string
  readonly question: string
  readonly kind: NodeKind
  readonly dependsOn: readonly string[]
  readonly impact: Impact
  status: NodeStatus
  answer?: string
  origin?: "user" | "proposed_and_confirmed" | "fact" | "assumed"
  settledAt?: number
}
export interface DesignTree {
  nodes: DesignNode[]
  current?: string
  depth: Depth
  asked: number
  turn: number
}
