// "Installed" has one meaning in this plugin: a file of that name on PATH. browser.ts used this test for ffmpeg and
// ffprobe; backends.ts asks it about the optional local decision servers (A2-T1), so the test lives in one place.

import { statSync } from "node:fs"
import { join } from "node:path"

export function findTool(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""]
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      try {
        if (statSync(file).isFile()) return file
      } catch {
        // not here
      }
    }
  }
  return undefined
}
