// One setup per plugin id per location, so composing @omacode/full with an
// individually installed plugin cannot register the same hooks twice, while a
// server that boots several directories still gets the plugin in each of them.
//
// The host calls setup once per location and hands it ctx.location.directory. A
// claim with no location keeps the older per-process behaviour for hosts and
// tests that carry none, which is also what a single-directory server gets.
const installed = ((globalThis as { __omacodePlugins?: Set<string> }).__omacodePlugins ??= new Set<string>())

export function claim(id: string, location?: string): boolean {
  const key = location ? `${id}\u0000${location}` : id
  if (installed.has(key)) return false
  installed.add(key)
  return true
}

// Tests that set the same plugin up on fresh mocks need a clean registry.
export function resetClaims(): void {
  installed.clear()
}
