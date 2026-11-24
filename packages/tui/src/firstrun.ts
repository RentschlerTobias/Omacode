// First run (C2-T7): from "installed" to the first deck in one click. /first-deck (and a one-time offer on the first
// start) lets the user pick a sample brief; the TUI then opens a session with the build agent in a folder of omacode's
// own, sends it the brief, and the agent writes the deck, builds and checks it with make_artifact, presents it, and
// explains in plain words what just happened.
//
// The deck goes to `<data>/first-deck` (~/.local/share/omacode/first-deck), not into the home or a project: a first
// run must not leave a folder in a place the user keeps clean. The user is told where it is.
//
// Everything here is plain data and files so it can be tested without a terminal; tui.tsx does the dialogs.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { userDataDir, userStateDir } from "@omacode/core/paths"

export interface Brief {
  readonly id: string
  readonly title: string
  readonly topic: string
}

// Three topics a non-technical user can judge at a glance. Each asks for a different kind of slide, so the first deck
// shows titles, short lines and one reveal.
export const BRIEFS: readonly Brief[] = [
  { id: "local-ai", title: "Why run AI on your own computer", topic: "why someone would run AI models on their own computer instead of in the cloud: privacy, cost, working offline, and the honest trade-offs" },
  { id: "team-week", title: "A team's week in review", topic: "a short weekly update for a small team: what shipped, what is blocked, what comes next, and one thank-you" },
  { id: "repair-cafe", title: "Opening a neighbourhood repair café", topic: "a pitch to neighbours for a monthly repair café: the idea, what people bring, what volunteers do, and how to join" },
]

// The welcome on the first start: what the user wants to make decides which parts are offered. Parts that need sudo
// (Chromium, ffmpeg) are named with the terminal command; the others are installed from the TUI (features.ts).
export interface Goal {
  readonly id: string
  readonly title: string
  readonly parts: readonly string[]
  // after the install, the first deck is offered
  readonly firstDeck?: boolean
}

export const GOALS: readonly Goal[] = [
  { id: "decks", title: "Slide decks", parts: ["hyperframes", "chromium"], firstDeck: true },
  { id: "videos", title: "Videos", parts: ["hyperframes", "ffmpeg"] },
  { id: "images", title: "Images with local models", parts: ["comfyui", "comfy-mcp"] },
  { id: "code", title: "Code, with the local decider and memory", parts: ["services"] },
  { id: "none", title: "Nothing to install now (/setup later)", parts: [] },
]

export const FIRST_DECK_DIR = "first-deck"
const OFFERED_FILE = "first-run.json"

// One folder per brief, so a second first run with another topic does not overwrite the first deck.
export const firstDeckDir = (brief: Brief, data = userDataDir()): string => join(data, FIRST_DECK_DIR, brief.id)

// The message the build agent gets. It names the steps so the agent does not have to guess what a first run is, and it
// asks for the explanation in plain words because that explanation is the point of the exercise.
export function firstDeckPrompt(brief: Brief): string {
  return [
    "This is my first run of omacode. Make me a short slide deck and present it.",
    "",
    `Topic: ${brief.topic}.`,
    "",
    "1. Read the deck skill first.",
    "2. Write deck.json in the current directory: 4 or 5 slides, each with a title, a body of one to three short lines (one line per point) and speaker notes. Give one slide reveals, so its points come one click at a time.",
    "3. Build it with make_artifact (spec: deck.json, present: yes).",
    "4. If a check fails, fix deck.json and build again. Never weaken a check.",
    "5. When the deck is presented, explain to me in plain words, without technical terms, in at most six short sentences: what you made, what the checks looked at, where the files are (give the full folder path), how to step through the slides (arrow keys or the arrows at the bottom right), and that I can simply ask you for changes.",
    "Give me the presenter's address in your answer. Do not say the deck looks good unless the presenter check passed.",
  ].join("\n")
}

// Whether HyperFrames is installed where the build will look for it (the PATH the host runner searches).
export function hyperframesInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env["PATH"] ?? "").split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, "hyperframes"), constants.X_OK)
      return true
    } catch {
      // not here
    }
  }
  return false
}


// The one-time offer on the first start: offered once, whatever the answer, so it never nags. /first-deck stays.
export const offeredPath = (state = userStateDir()): string => join(state, OFFERED_FILE)

export function wasOffered(path = offeredPath()): boolean {
  if (!existsSync(path)) return false
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { offered?: unknown }).offered === true
  } catch {
    return true // a file we cannot read was written by us; do not offer again
  }
}

export function markOffered(path = offeredPath(), now = new Date()): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({ offered: true, at: now.toISOString() })}\n`, { mode: 0o600 })
}

// The folder the session works in; made before the session starts, because a session location must exist.
export function prepareFirstDeckDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
