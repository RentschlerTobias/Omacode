import guard from "@omacode/guard"
import sandbox from "@omacode/sandbox"
import context from "@omacode/context"

export interface FullPluginDeps {
  readonly guard?: Parameters<typeof guard.setup>[1]
  readonly sandbox?: Parameters<typeof sandbox.setup>[1]
  readonly context?: Parameters<typeof context.setup>[1]
}

// One install for the plugins that make sense together. Each one claims its id, so
// adding a package twice (full and standalone) still registers its hooks once.
export default {
  id: "omacode-full",
  async setup(ctx: unknown, deps: FullPluginDeps = {}): Promise<void> {
    await guard.setup(ctx, deps.guard)
    await sandbox.setup(ctx, deps.sandbox)
    await context.setup(ctx, deps.context)
  },
}
