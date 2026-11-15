// The path rule the host runner (B1-T5) and provenance (B1-T3) share: what a path really is, and whether it stays under
// a root. `realpath` alone answers only for a path that exists, and the interesting cases are the ones that do not exist
// yet — the output a renderer is about to write, or a job directory half laid out. `realish` resolves the nearest
// existing ancestor and appends the part that is missing, the same rule the plan guard uses
// (packages/micromanager/src/writeguard.ts), so a symlinked parent is seen for what it is before the child exists.
//
// Nothing here creates, reads or throws: a path that cannot be resolved is answered as it is, never as an error, because
// a refusal the caller can describe is worth more than a throw from a helper. The runner turns `insidePath` into a
// sentence; provenance turns it into a manifest entry that is "outside" rather than "missing".

import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

// An absolute path with every symlink along it resolved, including the ones in the part that does not exist yet:
// `realpath` of the nearest existing ancestor, and the missing tail appended in order. A link that cannot be followed
// (its target is missing) is treated as that ancestor: its own directory resolves and its name stays a name, so nothing
// is followed through it. Never throws.
export function realish(path: string): string {
  let current = resolve(path)
  const below: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return below.length ? join(real, ...below) : real
    } catch {
      // Not resolvable: missing, or a link whose target is missing.
    }
    let link = false
    try {
      link = lstatSync(current).isSymbolicLink()
    } catch {
      link = false
    }
    const parent = dirname(current)
    if (link) {
      let up = parent
      try {
        up = realpathSync(parent)
      } catch {
        // The root itself is unreadable: use it as it is rather than guess.
      }
      return join(up, basename(current), ...below)
    }
    if (parent === current) return join(current, ...below)
    below.unshift(basename(current))
    current = parent
  }
}

// Whether `candidate` is `root` or lies below it, compared by path segments after both are resolved, so a symlink that
// leaves the root is outside even when its name looks harmless, and a sibling whose name merely starts with the root's
// ("/job-1" beside "/job-10") is not accepted by a string prefix. `realish` rather than `realpath`, because the case
// that matters is a path whose last part does not exist yet.
export function insidePath(root: string, candidate: string): boolean {
  const rel = relative(realish(root), realish(candidate))
  if (rel === "") return true
  // `..` alone is the parent; `../x` is a sibling's subtree. A child literally named "..name" is not an escape, so the
  // separator is required — the same test the plan guard makes.
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
}
