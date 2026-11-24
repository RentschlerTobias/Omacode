// Whether a module is the program node was started with. import.meta.main is the native answer but not in every Node
// the plugin supports, and a program started through an npm bin link is a symlink: argv[1] is compared by its real path.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function isMain(meta: { url: string; main?: boolean }): boolean {
  if (typeof meta.main === "boolean") return meta.main
  const started = process.argv[1]
  if (!started) return false
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(meta.url))
  } catch {
    return false
  }
}
