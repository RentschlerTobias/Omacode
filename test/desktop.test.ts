// P3-T3: without a display the plugin hands nothing to the desktop; the chat is where the user hears it.

import assert from "node:assert/strict"
import { test } from "node:test"

import { hasDesktop, notifyDesktop } from "../packages/micromanager/src/desktop.ts"

test("a desktop is there when a display is named, on macOS, or when the user says so", () => {
  assert.equal(hasDesktop({ WAYLAND_DISPLAY: "wayland-1" }, "linux"), true)
  assert.equal(hasDesktop({ DISPLAY: ":0" }, "linux"), true)
  assert.equal(hasDesktop({}, "linux"), false, "a container or an SSH session")
  assert.equal(hasDesktop({}, "darwin"), true)
  assert.equal(hasDesktop({ DISPLAY: ":0", OMACODE_HEADLESS: "1" }, "linux"), false)
  assert.equal(hasDesktop({ OMACODE_HEADLESS: "0" }, "linux"), true)
})

test("without a desktop no notifier runs, and the caller hears it once", () => {
  const ran: string[] = []
  const told: string[] = []
  const run = ((cmd: string) => { ran.push(cmd) }) as never
  notifyDesktop("t", "b", (err) => told.push(err.message), false, run)
  notifyDesktop("t", "b", (err) => told.push(err.message), false, run)
  assert.deepEqual(ran, [])
  assert.equal(told.length, 1)
  assert.match(told[0]!, /no desktop/)
  notifyDesktop("t", "b", undefined, true, run)
  assert.equal(ran.length, 1, "with one the notifier runs")
})
