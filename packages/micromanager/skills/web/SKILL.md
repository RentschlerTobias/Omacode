---
name: web
description: Build and check a website with the site adapter. Use when a task produces a web page, a landing page, a small site or a web app's static pages, or when a site has to pass its checks before it is shown.
license: Apache-2.0
metadata:
  source: own
  verified_against: playwright-core 1.64, axe-core 4.14, Chromium 155
---

# Website

A site is data first: a `SiteSpec` (version 2) names the pages, where the site lives and how it is built. The site
adapter serves it from its own directory, opens every page in a real browser at three widths and runs axe on it. Your
job is the pages and the spec, not the checks.

## What the spec says

- `pages[]`, each with `path` (relative to what is served, e.g. `index.html`, `docs/intro.html`) and `title`.
- `root`: the directory with the site's sources, relative to the job; without it the job directory itself.
- `build` (only for a built site): `script`, the npm script that builds it (`build`, not a command line), and `out`, the
  directory it writes, relative to `root`. Install the packages before the checks: the build runs without a network.
- `budget.kb`: the most a page may weigh with everything it loads; 1500 KB without one.
- `brand.colors` (hex) and `brand.fonts`: what a reviewer holds the pages against.

Start static: plain HTML, CSS and a little JavaScript need no build and are checked exactly like a built site.

## What the site must survive

- **pages** — every page in the spec exists.
- **links** — every local `href`, `src` and `srcset` lands on a file (`about` may mean `about.html`, a directory means
  its `index.html`). Links to other sites are listed, not followed: the checks run offline.
- **build** — `npm run <script>` exits zero.
- **load, console, requests** — each page loads at 390, 768 and 1280 px, throws nothing, logs no error, and everything
  it asks for is there. A font or script from a CDN fails offline: ship it with the site.
- **overflow** — nothing is wider than the window; the phone width is where this fails.
- **a11y** — axe finds nothing `serious` or `critical`: alt text on images, labels on inputs, enough contrast, a
  `lang` on `<html>`. `moderate` findings are reported in the passing text; fix them when they are cheap.
- **weight** — each page stays inside its budget.
- **snapshot, blank** — a screenshot of every page at every width, and none of them empty.

## When something fails

Fix the page, not the check. An overflow wants a layout that wraps (`max-width: 100%`, `flex-wrap`, no fixed widths),
not `overflow: hidden` on `body`; a contrast failure wants darker text, not a bigger font. If a check is `skipped` or
fails because no browser could run, say so in the report: an absence is never a pass.
