import contextPlugin from "@omacode/context"
import guard from "@omacode/guard"
import micromanager from "@omacode/micromanager"
import sandbox from "@omacode/sandbox"

export interface FullPluginDeps {
  readonly guard?: Parameters<typeof guard.setup>[1]
  readonly sandbox?: Parameters<typeof sandbox.setup>[1]
  readonly context?: Parameters<typeof contextPlugin.setup>[1]
  readonly micromanager?: { setup(ctx: unknown, deps?: unknown): unknown }
  readonly micromanagerDeps?: unknown
}

// One install for guard, sandbox, context and the orchestrator. Each plugin claims its id,
// so adding a package twice (full and standalone) still registers its hooks once.
export default {
  id: "omacode-full",
  async setup(ctx: unknown, deps: FullPluginDeps = {}): Promise<void> {
    await guard.setup(ctx, deps.guard)
    await sandbox.setup(ctx, deps.sandbox)
    await contextPlugin.setup(ctx, deps.context)
    await (deps.micromanager ?? micromanager).setup(ctx, deps.micromanagerDeps)
  },
}
