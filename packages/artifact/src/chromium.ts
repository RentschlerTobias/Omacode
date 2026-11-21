// The Chromium a page is rendered with, found once for the plugin's `look` and `browser` tools and for the site
// adapter's probe (B4), so the two cannot pick different browsers on one machine.

import { accessSync, constants, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// The browser to render with: the first executable Chromium found on PATH, in Playwright's cache, or the macOS app.
// Existence alone is not enough: a broken or non-executable path must not be chosen and then fail every screenshot.
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const executable = (file: string): boolean => {
    try {
      accessSync(file, constants.X_OK)
      return statSync(file).isFile()
    } catch {
      return false
    }
  }
  const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "brave"]
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    for (const n of names) {
      const file = join(dir, n)
      if (executable(file)) return file
    }
  }
  const pw = join(env.HOME ?? homedir(), ".cache", "ms-playwright")
  try {
    for (const d of readdirSync(pw).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const file = join(pw, d, sub)
        if (executable(file)) return file
      }
    }
  } catch {
    // no Playwright cache
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  return executable(mac) ? mac : undefined
}
