// Compiles the TUI entry into the .js entry the host can load.
//
// OpenCode's Solid transform skips every path containing `node_modules`, so the
// raw .tsx entry of a package install (npm, git+, github: specs land under
// <cache>/npm/.../node_modules/<pkg>/) is compiled against Bun's default JSX
// runtime and dies with "Cannot find package 'react'" (opencode#39986,
// opentui#1741). A .js entry with no JSX loads everywhere: its bare imports
// (@opentui/solid, solid-js, @opencode/plugin/tui) are rewritten to the host's
// runtime, so signals still update and the plugin shares the host instance.
//
// Usage: node scripts/build-tui.mjs [in] [out]   (default: packages/tui/src/tui.tsx → packages/tui/src/tui.js)

import { transformFileSync } from "@babel/core"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const banner = "// @generated from packages/tui/src/tui.tsx by `npm run build:tui` — do not edit.\n"

export function compileTui(file = "packages/tui/src/tui.tsx") {
  const { code } = transformFileSync(resolve(file), {
    babelrc: false,
    configFile: false,
    presets: [
      ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
      ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ],
  })
  return banner + code
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = resolve(process.argv[2] ?? "packages/tui/src/tui.tsx")
  const out = resolve(process.argv[3] ?? "packages/tui/src/tui.js")
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, compileTui(input))
  console.log(`wrote ${out}`)
}
