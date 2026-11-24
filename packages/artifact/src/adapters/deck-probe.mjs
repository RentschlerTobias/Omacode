// The deck adapter's presenter probe (deck.present). The adapter copies this file into the job (`.probe/deck-probe.mjs`)
// on every prepare and the host runner starts it with `node`, under bubblewrap with the network unshared, like the site
// probe. It looks at what the person presenting will see, not at a render of the page:
//
//   node .probe/deck-probe.mjs <report.json> <shots dir>
//
// It starts `hyperframes present` on the job (the binary is DECK_PROBE_HYPERFRAMES, an absolute path the adapter resolved,
// so nothing here searches PATH), opens the presenter in Chromium (DECK_PROBE_CHROMIUM), waits for the player to report
// its scenes, then steps through every rest point of the main line with the arrow key, as a presenter would. At each one
// it records which slides are on stage and whether the title is shown, and photographs each slide once. Console errors,
// page errors and failed requests are recorded too, except the presenter's optional sound clips and the favicon, which
// HyperFrames requests for every deck and documents as allowed to be missing.
//
// It writes one JSON report and exits 0 when it could look; a broken presenter is a finding in the report, not an exit
// code. Plain JavaScript on purpose: it runs from the job, where no TypeScript toolchain is promised. Playwright is the
// adapter's dependency, found through NODE_PATH.

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)

const START_PORT = "3904"
const STARTUP_MS = 60_000
const SCENES_MS = 20_000
// Long enough for a slide's parts to finish rising in (the last starts after about half a second and takes 0.7 s).
const SETTLE_MS = 1_600
const IGNORED = [/\/composition\/sfx\/[^/]+\.mp3$/, /\/favicon\.ico$/]

const ignored = (url) => IGNORED.some((re) => re.test(url.split(/[?#]/)[0] ?? url))

// `hyperframes present` prints its address once it listens; the start port is a wish, the printed one is the fact.
function startPresenter(bin, jobDir) {
  return new Promise((done, fail) => {
    const child = spawn(bin, ["present", jobDir, "--no-open", "--port", START_PORT], { stdio: ["ignore", "pipe", "pipe"] })
    let said = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      fail(new Error(`hyperframes present named no address within ${STARTUP_MS / 1000} s: ${said.slice(-400)}`))
    }, STARTUP_MS)
    const read = (chunk) => {
      said += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")
      const port = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(said)?.[1]
      if (port) {
        clearTimeout(timer)
        done({ child, url: `http://127.0.0.1:${port}/` })
      }
    }
    child.stdout.on("data", read)
    child.stderr.on("data", read)
    child.once("error", (err) => {
      clearTimeout(timer)
      fail(err)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      fail(new Error(`hyperframes present exited with ${code} before it listened: ${said.slice(-400)}`))
    })
  })
}

async function probe(reportPath, shotsDir) {
  const report = { url: undefined, errors: [], scenes: 0, steps: [], shots: [], problem: undefined }
  const bin = process.env.DECK_PROBE_HYPERFRAMES
  if (!bin) {
    report.problem = "the adapter gave the probe no hyperframes binary (DECK_PROBE_HYPERFRAMES)"
    return report
  }
  const { chromium } = require("playwright-core")
  let presenter
  let browser
  // Chromium's singleton socket needs a short TMPDIR (see web-probe.mjs).
  const shortTmp = tmpdir().length > 60 ? mkdtempSync("/dev/shm/deck-probe-") : undefined
  try {
    presenter = await startPresenter(bin, resolve("."))
    report.url = presenter.url
    browser = await chromium.launch({
      executablePath: process.env.DECK_PROBE_CHROMIUM || undefined,
      ...(shortTmp ? { env: { ...process.env, TMPDIR: shortTmp } } : {}),
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-gpu", "--disable-background-networking", "--hide-scrollbars", "--mute-audio"],
    })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on("console", (m) => {
      if (m.type() !== "error" && !(m.type() === "warning" && m.text().includes("[hyperframes"))) return
      // A failed load is reported again by the response handler with its URL, which is the part worth reading.
      if (/^Failed to load resource/.test(m.text())) return
      report.errors.push(`${m.type()}: ${m.text().slice(0, 400)}`)
    })
    page.on("pageerror", (err) => report.errors.push(`page error: ${String(err?.message ?? err).slice(0, 400)}`))
    page.on("response", (r) => {
      if (r.status() >= 400 && !ignored(r.url())) report.errors.push(`${r.status()} for ${r.url()}`)
    })
    page.on("requestfailed", (r) => {
      if (!ignored(r.url())) report.errors.push(`request failed: ${r.url()} (${r.failure()?.errorText ?? "no reason"})`)
    })

    await page.goto(presenter.url, { waitUntil: "load" })
    try {
      await page.waitForFunction(
        () => {
          const player = document.querySelector("hyperframes-player")
          return Boolean(player && Array.isArray(player.scenes) && player.scenes.length > 0)
        },
        undefined,
        { timeout: SCENES_MS },
      )
    } catch {
      report.problem = `the player reported no scenes within ${SCENES_MS / 1000} s, so the slideshow had nothing to step through`
    }
    report.scenes = await page.evaluate(() => document.querySelector("hyperframes-player")?.scenes?.length ?? 0)

    // The rest points a presenter steps through: one per slide without reveals, one per fragment otherwise.
    const island = await page.evaluate(() => {
      const el = document.querySelector('hyperframes-slideshow script[type="application/hyperframes-slideshow+json"]')
      try {
        return JSON.parse(el?.textContent ?? "{}")
      } catch {
        return {}
      }
    })
    const stops = (island.slides ?? []).flatMap((slide) =>
      Array.from({ length: Math.max(1, (slide.fragments ?? []).length) }, (_, k) => ({ sceneId: slide.sceneId, stop: k })),
    )
    mkdirSync(shotsDir, { recursive: true })
    for (const [index, stop] of stops.entries()) {
      if (index > 0) await page.keyboard.press("ArrowRight")
      await page.waitForTimeout(SETTLE_MS)
      const frame = page.frames().find((f) => f !== page.mainFrame())
      const seen = frame
        ? await frame.evaluate(() =>
            Array.from(document.querySelectorAll("section[data-composition-id]"))
              .filter((s) => {
                const style = getComputedStyle(s)
                return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.01
              })
              .map((s) => {
                const title = s.querySelector("h2")
                return {
                  id: s.getAttribute("data-composition-id"),
                  titleOpacity: title ? Number(getComputedStyle(title).opacity) : null,
                }
              }),
          )
        : []
      const entry = { expected: stop.sceneId, stop: stop.stop, visible: seen.map((s) => s.id), titleOpacity: seen[0]?.titleOpacity ?? null }
      report.steps.push(entry)
      if (stop.stop === 0) {
        const shot = join(shotsDir, `present-${String(index).padStart(2, "0")}-${stop.sceneId}.png`)
        await page.screenshot({ path: shot })
        report.shots.push(shot)
      }
    }
  } catch (err) {
    report.problem = err instanceof Error ? err.message : String(err)
  } finally {
    await browser?.close().catch(() => {})
    presenter?.child.kill("SIGTERM")
    if (shortTmp) rmSync(shortTmp, { recursive: true, force: true })
  }
  return report
}

const [reportPath, shotsDir] = process.argv.slice(2)
if (!reportPath || !shotsDir) {
  console.error("usage: node deck-probe.mjs <report.json> <shots dir>")
  process.exit(2)
}
const report = await probe(reportPath, shotsDir)
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
process.exit(0)
