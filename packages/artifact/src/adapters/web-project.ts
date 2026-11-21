// The site adapter's view of a site on disk (B4-T1/T2): where it lives, what is served, whether every page the spec
// names is there, and whether every link and reference inside the pages lands on a file. All of it is read from files;
// nothing here starts a program, so these answers hold without a browser and are the L1 half of the site's checks.
//
// One build contract (B4-T2). A static site is its files under `root` (the job directory without one). A built site
// names an npm script and the directory it writes, relative to `root`; that directory is what is served. Pages, links
// and the probe all work on the served directory, so a static site and a built one are checked the same way.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, posix, relative, resolve } from "node:path"

import { insidePath } from "../paths.ts"
import type { SiteSpec } from "../spec.ts"

export interface SiteLink {
  readonly page: string // the page it is on, relative to the served directory
  readonly ref: string // as written in the page
  readonly target?: string // the file it resolves to, relative to the served directory; absent when it lands nowhere
}

export interface SitePage {
  readonly path: string
  readonly exists: boolean
  readonly title?: string // the page's own <title>, when it has one
}

export interface SiteProject {
  readonly root: string // absolute: where the site's sources (and a package.json) are
  readonly served: string // absolute: what is served and checked
  readonly pages: readonly SitePage[]
  readonly links: readonly SiteLink[] // every local reference in every page that exists
  readonly external: readonly string[] // distinct references to another origin; reported, never followed
  readonly files: readonly string[] // what is served, relative to the job directory
}

// Where the sources are and what is served, both absolute and both inside the job. A spec path is lexical (spec.ts),
// so `..` cannot occur; the containment check here is for a symlink that points out.
export function siteDirs(spec: SiteSpec, jobDir: string): { root: string; served: string } {
  const job = resolve(jobDir)
  const root = spec.root ? resolve(job, spec.root) : job
  const served = spec.build ? resolve(root, spec.build.out) : root
  for (const [what, dir] of [["root", root], ["served directory", served]] as const) {
    if (!insidePath(job, dir)) throw new Error(`site: the ${what} ${dir} is outside the job directory`)
  }
  return { root, served }
}

// Attributes that load or lead somewhere. `srcset` is split into its candidates; inline data and scripts are not refs.
const REF = /\b(?:href|src|poster|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i
// A reference with a scheme or a protocol-relative one goes to another origin (or is mailto:, tel:, data:, javascript:).
const OTHER_ORIGIN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

function refsIn(html: string): string[] {
  const refs: string[] = []
  for (const m of html.matchAll(REF)) refs.push((m[1] ?? m[2] ?? "").trim())
  for (const m of html.matchAll(SRCSET)) {
    for (const candidate of (m[1] ?? m[2] ?? "").split(",")) {
      const url = candidate.trim().split(/\s+/)[0]
      if (url) refs.push(url)
    }
  }
  return refs.filter((r) => r !== "")
}

// The file a local reference lands on, the way a static server answers it: a directory is its index.html, and a path
// without an extension may be a page written as "about" for "about.html". Query and fragment do not name a file.
export function resolveRef(served: string, page: string, ref: string): string | undefined {
  const bare = ref.split("#")[0]!.split("?")[0]!
  if (bare === "") return page // "#top" or "?x": the page itself
  let decoded: string
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    return undefined
  }
  const from = bare.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(page), decoded)
  const normal = posix.normalize(from).replace(/^\/+/, "")
  if (normal.startsWith("..")) return undefined // above the served directory: no static server hands that out
  const candidates = normal === "" || normal === "." || bare.endsWith("/")
    ? [posix.join(normal === "." ? "" : normal, "index.html")]
    : [normal, `${normal}.html`, posix.join(normal, "index.html")]
  for (const candidate of candidates) {
    const full = join(served, candidate)
    if (!insidePath(served, full)) continue
    try {
      if (statSync(full).isFile()) return candidate
    } catch {
      // not this one
    }
  }
  return undefined
}

function listFiles(dir: string, jobDir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    if (name === "node_modules" || name === ".git") continue
    const full = join(dir, name)
    try {
      const info = statSync(full)
      if (info.isDirectory()) listFiles(full, jobDir, out)
      else if (info.isFile()) out.push(relative(jobDir, full))
    } catch {
      // gone while listing
    }
  }
  return out
}

export function scanSite(spec: SiteSpec, jobDir: string): SiteProject {
  const { root, served } = siteDirs(spec, jobDir)
  const pages: SitePage[] = []
  const links: SiteLink[] = []
  const external = new Set<string>()
  for (const page of spec.pages) {
    const file = join(served, page.path)
    const exists = existsSync(file) && statSync(file).isFile()
    let title: string | undefined
    if (exists) {
      const html = readFileSync(file, "utf8")
      title = html.match(TITLE)?.[1]?.replace(/\s+/g, " ").trim() || undefined
      for (const ref of refsIn(html)) {
        if (OTHER_ORIGIN.test(ref)) {
          if (/^(?:https?:)?\/\//i.test(ref)) external.add(ref)
          continue
        }
        const target = resolveRef(served, page.path, ref)
        links.push({ page: page.path, ref, ...(target !== undefined ? { target } : {}) })
      }
    }
    pages.push({ path: page.path, exists, ...(title !== undefined ? { title } : {}) })
  }
  const files = existsSync(served) ? listFiles(served, resolve(jobDir)) : []
  return { root, served, pages, links, external: [...external].sort(), files }
}

// The directory a page's shots are named after: "docs/intro.html" → "docs-intro". Shots of two pages never collide,
// because two page paths that differ only in "/" and "-" would also be two specs that name their pages badly.
export function pageSlug(path: string): string {
  return path.replace(/\.html?$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "index"
}

// Where the shots of a run go, inside the job: `dirname` of this is created by the probe.
export const SHOTS_DIR = "shots"
export const shotPath = (page: string, width: number): string => join(SHOTS_DIR, `${pageSlug(page)}-${width}.png`)

// The directory the probe's own files sit in. It is inside the job because the runner refuses an argument naming a path
// outside it; `prepare` writes it fresh on every run, so a worker cannot leave a probe of its own there.
export const PROBE_DIR = ".probe"
export const probeDir = (jobDir: string): string => join(resolve(jobDir), PROBE_DIR)
