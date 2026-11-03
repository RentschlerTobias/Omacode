import { record } from "@omacode/core/journal"

import { ledger } from "./ledger.ts"
import { ContextManager } from "./manager.ts"
import { Memory } from "./memory.ts"
import { PriceBook } from "./prices.ts"
import { CoreSnapshots } from "./recall.ts"
import { writeStatus } from "./status.ts"
import { ReportedUsage, findUsage, tapResponse } from "./tokens.ts"

export interface ContextPluginDeps {
  readonly ceilingTokens?: number | ((agent?: string) => number)
  readonly keepTurns?: number
  readonly memory?: boolean
  readonly journal?: (entry: Record<string, unknown>) => void
}

const DEFAULT_CEILING = 100_000
const DEFAULT_KEEP_TURNS = 8

const ceilingFor = (deps: ContextPluginDeps, agent?: string): number => {
  const c = deps.ceilingTokens
  if (typeof c === "function") return c(agent)
  if (typeof c === "number") return c
  if (agent === "micromanager") return 100_000
  return DEFAULT_CEILING
}

export default {
  id: "omacode-context",
  setup: (ctx: any, deps: ContextPluginDeps = {}) => {
    const journal = deps.journal ?? record
    const manager = new ContextManager({ journal })
    const reported = new ReportedUsage()
    const prices = new PriceBook(() => ctx.model?.list?.() ?? [])
    const snapshots = new CoreSnapshots()
    const memory = deps.memory === false ? undefined : new Memory(undefined, journal)
    const project = (): string | undefined => ctx.location?.directory

    const context = async (input: any): Promise<void> => {
      const sessionID = input?.sessionID
      if (!sessionID || !Array.isArray(input.messages)) return

      const core = memory ? snapshots.get(sessionID, () => memory.core(project())) : ""
      if (core && Array.isArray(input.system)) input.system.push({ type: "text", text: core })

      const baseChars = Array.isArray(input.system)
        ? input.system.reduce((n: number, part: any) => n + String(part?.text ?? "").length, 0)
        : 0
      const ceiling = ceilingFor(deps, input.agent)
      const result = await manager.apply(sessionID, input.messages, {
        prices: await prices.get(input.model),
        ceilingTokens: ceiling,
        baseChars,
        keepTurns: deps.keepTurns ?? DEFAULT_KEEP_TURNS,
        reportedTokens: reported.tokens(sessionID),
      })

      if (result.epoch) snapshots.refresh(sessionID)
      const stats = manager.stats(sessionID)
      writeStatus(sessionID, {
        tokens: result.contextTokens,
        ceiling,
        summaryAt: Math.round(ceiling * 0.9),
        epochs: stats.epochs,
        savedChars: stats.savedChars,
        pending: stats.pending,
        at: Date.now(),
      })
    }

    const prompt = async (input: any): Promise<void> => {
      if (!memory) return
      const sessionID = input?.sessionID
      const text = String(input?.prompt?.text ?? "")
      if (!sessionID || !text) return
      const r = await memory.recallText(text, { projectDir: project(), session: sessionID }).catch(() => ({ text: "", ids: [] }))
      if (!r.text) return
      input.prompt.text = `${text}\n\n${r.text}`
    }

    return (async () => {
      await ctx.session.hook("context", context)
      await ctx.session.hook("prompt", prompt)
      try {
        ctx.session.hook("http.response", (event: any) => {
          if (!event?.sessionID) return
          event.response = tapResponse(event.response, (body: string) => reported.record(event.sessionID, findUsage(body)))
        })
      } catch {
        // Hosts without the response hook fall back to the estimate.
      }
    })()
  },
}
