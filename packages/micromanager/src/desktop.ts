// What the plugin hands to the desktop: notifications only. Previews, presenters and comparison pages are never opened
// by the plugin; they start with --no-open and their URL or path goes into the answer, so they work the same with and
// without a display (container plan P3-T3).
//
// Without a display (a container, an SSH session, a server) a notification has nowhere to go: notify-send would fail
// on every call. It is not attempted then, and the caller hears it once, so the answer in the chat is the one place the
// user is told.

import { execFile } from "node:child_process"

// Whether there is a desktop to notify. macOS always has one for the user's own processes; Linux has one when a
// Wayland or X display is named. OMACODE_HEADLESS=1 says there is none (an image sets it), OMACODE_HEADLESS=0 that
// there is one whatever the variables say.
export function hasDesktop(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.OMACODE_HEADLESS === "1") return false
  if (env.OMACODE_HEADLESS === "0") return true
  if (platform === "darwin") return true
  return Boolean(env.WAYLAND_DISPLAY || env.DISPLAY)
}

let toldHeadless = false

// A desktop notification: `notify-send` on Linux, `osascript` on macOS, which has no notify-send. The command is
// chosen here once, so the plugin installs unchanged on both (`opencode plugin add` from git). Failure is the
// caller's business: a notification is a courtesy and never a reason a job stops. Without a desktop nothing runs, and
// `failed` hears it the first time only.
export function notifyDesktop(title: string, body: string, failed?: (err: Error) => void, desktop = hasDesktop(), run: typeof execFile = execFile): void {
  if (!desktop) {
    if (!toldHeadless && failed) failed(new Error("no desktop (no WAYLAND_DISPLAY or DISPLAY): notifications go to the chat only"))
    toldHeadless = true
    return
  }
  const darwin = process.platform === "darwin"
  const args = darwin ? ["-e", `display notification ${appleScript(body)} with title ${appleScript(title)}`] : ["-a", "omacode", title, body]
  run(darwin ? "osascript" : "notify-send", args, (err) => {
    if (err && failed) failed(err)
  })
}

// An AppleScript string literal: quotes and backslashes escape as in JSON. A newline would come out as a literal
// backslash-n (AppleScript has no \n escape), so the body is folded to one line first.
function appleScript(text: string): string {
  return JSON.stringify(text.replace(/\s*\n\s*/g, " "))
}
