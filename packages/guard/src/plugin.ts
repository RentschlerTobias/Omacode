import { record } from "@omacode/core/journal"
import { claim } from "@omacode/core/registry"
import { DEFAULT_LABELS, gitAuthor, useVault, Vault, type NameSettings } from "./redact.ts"
import { defaultDeps, installGuard, type GuardDeps } from "./wire.ts"
import { loadGuardSettings } from "./config.ts"

const GLINER = "http://127.0.0.1:8781/v1/entities"
const SHARED = ((globalThis as { __omacodeGuard?: { vault?: Vault } }).__omacodeGuard ??= {})

function fromConfig(projectDir?: string): Partial<GuardDeps> {
  const settings = loadGuardSettings(projectDir)
  const redacting = settings.secrets || settings.pii || settings.names
  const vault = redacting
    ? (SHARED.vault ??= new Vault({
        allow: [...settings.allow, ...gitAuthor()],
        secrets: settings.secrets,
        pii: settings.pii,
        journal: record,
      }))
    : undefined
  useVault(vault)
  const names: NameSettings | undefined = vault && settings.names && settings.nameAddress
    ? {
        url: process.env.OMACODE_GLINER_URL || GLINER,
        labels: DEFAULT_LABELS,
        threshold: settings.threshold,
      }
    : undefined
  return { getVault: () => vault, getNames: () => names }
}

export default {
  id: "omacode-guard",
  setup: (ctx: any, deps: Partial<GuardDeps> = {}) => {
    if (!claim("guard")) return
    const configured = deps.getVault ? {} : fromConfig(ctx?.location?.directory)
    installGuard(ctx, { ...defaultDeps(), ...configured, ...deps })
  },
}

export { installGuard } from "./wire.ts"
export type { GuardDeps } from "./wire.ts"
