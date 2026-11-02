import { installGuard, defaultDeps, type GuardDeps } from "./wire.ts"

export default {
  id: "micromanager-guard",
  setup: (ctx: unknown, deps: Partial<GuardDeps> = {}) => {
    installGuard(ctx, { ...defaultDeps(), ...deps })
  },
}

