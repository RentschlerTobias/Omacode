// One setup per plugin id per process, so composing @omacode/full with an
// individually installed plugin cannot register the same hooks twice.
const installed = ((globalThis as { __omacodePlugins?: Set<string> }).__omacodePlugins ??= new Set<string>())

export function claim(id: string): boolean {
  if (installed.has(id)) return false
  installed.add(id)
  return true
}

// Tests that set the same plugin up on fresh mocks need a clean registry.
export function resetClaims(): void {
  installed.clear()
}
