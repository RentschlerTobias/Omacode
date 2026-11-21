// The site adapter's browser probe (B4-T3). The adapter copies this file into the job (`.probe/web-probe.mjs`) on every
// prepare and the host runner starts it with `node`: the runner refuses an argument naming a path outside the job, and
// it is the only place a program may be started. It runs under bubblewrap with the network unshared, so the pages it
// opens can reach only the loopback server it starts itself.
//
//   node .probe/web-probe.mjs check <served dir> <report.json> <shots dir> <page>...
//   node .probe/web-probe.mjs serve <served dir> <port>
//
// `check` opens every page at three widths, records what the page threw and logged, what it failed to load, whether it
// is wider than the window, what it weighs and what it looks like, and runs axe once per page at the desktop width. It
// writes one JSON report and exits 0 when it could look; a page that is broken is a finding in the report, not an exit
// code. `serve` is the human's door: the same server, held until the runner cancels it.
//
// Plain JavaScript on purpose: it runs from the job, where no TypeScript toolchain is promised. Playwright and axe are
// the adapter's dependencies, found through NODE_PATH, and Chromium is the one the adapter found (WEB_PROBE_CHROMIUM).

import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { extname, join, normalize, resolve, sep } from "node:path"

const require = createRequire(import.meta.url)

export const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
]

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4",
  ".webm": "video/webm", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".webmanifest": "application/manifest+json",
}

// A static server the way a host would answer: a directory is its index.html, "about" may be "about.html", nothing
// outside the served directory is handed out.
function fileFor(root, url) {
  let path
  try {
    path = decodeURIComponent(new URL(url, "http://x").pathname)
  } catch {
    return undefined
  }
  const base = normalize(join(root, path))
  if (base !== root && !base.startsWith(root + sep)) return undefined
  for (const candidate of path.endsWith("/") ? [join(base, "index.html")] : [base, `${base}.html`, join(base, "index.html")]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // next
    }
  }
  return undefined
}

function serve(root, port) {
  const server = createServer((req, res) => {
    const file = fileFor(root, req.url ?? "/")
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" })
    createReadStream(file).pipe(res)
  })
  return new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(port, "127.0.0.1", () => done(server))
  })
}

async function check(root, reportPath, shotsDir, pages) {
  const { chromium } = require("playwright-core")
  const axePath = require.resolve("axe-core/axe.min.js")
  const server = await serve(root, 0)
  const origin = `http://127.0.0.1:${server.address().port}`
  // Chromium puts its singleton socket under TMPDIR, and a Unix socket path has room for 107 bytes. The runner points
  // TMPDIR into the job, whose path is often longer than that leaves room for, so Chromium then dies with "Socket path
  // too long". /dev/shm is writable inside the runner's sandbox and short; the directory is removed afterwards.
  const shortTmp = tmpdir().length > 60 ? mkdtempSync("/dev/shm/web-probe-") : undefined
  const browser = await chromium.launch({
    executablePath: process.env.WEB_PROBE_CHROMIUM || undefined,
    ...(shortTmp ? { env: { ...process.env, TMPDIR: shortTmp } } : {}),
    headless: true,
    // Chromium cannot build a sandbox of its own inside bubblewrap; the runner's sandbox is the boundary here.
    chromiumSandbox: false,
    args: ["--disable-gpu", "--disable-background-networking", "--hide-scrollbars", "--mute-audio"],
  })
  const report = { origin, chromium: browser.version(), viewports: VIEWPORTS, pages: [] }
  mkdirSync(shotsDir, { recursive: true })
  try {
    for (const path of pages) {
      const entry = { path, views: [], axe: undefined }
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
        const page = await context.newPage()
        const view = { width: vp.width, status: 0, console: [], errors: [], failed: [], external: [], overflow: false, bytes: 0, shot: undefined }
        page.on("console", (m) => { if (m.type() === "error") view.console.push(m.text().slice(0, 300)) })
        page.on("pageerror", (e) => view.errors.push(String(e?.message ?? e).slice(0, 300)))
        page.on("requestfailed", (r) => {
          const url = r.url()
          if (url.startsWith(origin)) view.failed.push(`${url.slice(origin.length)}: ${r.failure()?.errorText ?? "failed"}`)
          else if (/^https?:/.test(url)) view.external.push(url)
        })
        page.on("response", (r) => {
          const url = r.url()
          if (url.startsWith(origin) && r.status() >= 400) view.failed.push(`${url.slice(origin.length)}: HTTP ${r.status()}`)
        })
        page.on("requestfinished", async (r) => {
          try {
            const sizes = await r.sizes()
            view.bytes += sizes.responseBodySize + sizes.responseHeadersSize
          } catch {
            // the size is not known; the weight is a lower bound
          }
        })
        try {
          const response = await page.goto(`${origin}/${path}`, { waitUntil: "load", timeout: 20_000 })
          view.status = response?.status() ?? 0
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {})
          view.overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
          const shot = join(shotsDir, `${slug(path)}-${vp.width}.png`)
          await page.screenshot({ path: shot, fullPage: false })
          view.shot = shot
          if (vp.name === "desktop") {
            await page.addScriptTag({ content: readFileSync(axePath, "utf8") })
            entry.axe = await page.evaluate(async () => {
              // eslint-disable-next-line no-undef
              const r = await axe.run(document, { resultTypes: ["violations"] })
              return r.violations.map((v) => ({ id: v.id, impact: v.impact ?? "minor", help: v.help, nodes: v.nodes.length }))
            })
          }
        } catch (error) {
          view.errors.push(`could not load: ${String(error?.message ?? error).split("\n")[0].slice(0, 300)}`)
        }
        entry.views.push(view)
        await context.close()
      }
      report.pages.push(entry)
    }
  } finally {
    await browser.close()
    server.close()
    if (shortTmp) rmSync(shortTmp, { recursive: true, force: true })
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
}

// The same name the adapter gives a page's shots (web-project.ts pageSlug).
function slug(path) {
  return path.replace(/\.html?$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "index"
}

const [mode, dir, ...rest] = process.argv.slice(2)
const root = resolve(dir ?? ".")
if (mode === "check") {
  const [reportPath, shotsDir, ...pages] = rest
  await check(root, resolve(reportPath), resolve(shotsDir), pages)
} else if (mode === "serve") {
  const server = await serve(root, Number(rest[0]))
  process.stdout.write(`serving ${root} on http://127.0.0.1:${server.address().port}/\n`)
  await new Promise(() => {})
} else {
  process.stderr.write("usage: web-probe.mjs check <dir> <report.json> <shots dir> <page>... | serve <dir> <port>\n")
  process.exit(2)
}
