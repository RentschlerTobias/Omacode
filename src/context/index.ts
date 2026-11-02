import { installGuard, defaultDeps, type GuardDeps } from "../guard/wire.ts"

export interface ContextHookInput {
  sessionID?: string
  agent?: string
  messages?: unknown
  prompt?: { text?: string }
  system?: { type: string; text: string }[]
  tools?: Record<string, unknown>
  model?: { providerID?: string; id?: string }
}

export interface ContextDeps {
  shapeContext?: (input: ContextHookInput) => Promise<void>
  getVault?: () => any
  getNames?: () => any
  log?: (level: "info" | "warn" | "error", message: string) => void
}

export function installContext(ctx: any, deps: ContextDeps = {}) {
  const d: GuardDeps = {
    shapeContext: deps.shapeContext,
    getVault: deps.getVault ?? defaultDeps().getVault,
    getNames: deps.getNames ?? defaultDeps().getNames,
    log: deps.log,
  }
  installGuard(ctx, d)
}

export default {
  id: "micromanager-context",
  setup: (ctx: unknown, deps: Partial<ContextDeps> = {}) => {
    installContext(ctx, { ...defaultDeps() as any, ...deps })
  },
}
