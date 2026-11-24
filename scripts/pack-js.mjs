#!/usr/bin/env node
// prepack and postpack of every workspace package (run with the package directory as cwd).
//
// The repository runs TypeScript directly: OpenCode loads the plugin with Bun, and Node 22.18+ strips types for the
// tests and the CLI. Node refuses to strip types under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so
// an installed package would have a CLI and a services unit that cannot start. The published package therefore
// carries JavaScript:
//
//   node scripts/pack-js.mjs            (prepack) src/ → dist/ with TypeScript's transpileModule (no type check here:
//                                       `npm run typecheck` is the check), relative ".ts" imports rewritten to ".js",
//                                       and package.json's exports, bin and files pointed at dist/; the LICENSE, and
//                                       for @omacode/micromanager the decider sources and THIRD_PARTY.md, copied in
//   node scripts/pack-js.mjs --restore  (postpack) package.json back as it was, every copy removed
//
// Nothing is written outside the package directory, and --restore leaves the tree as git has it.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkgDir = process.cwd()
const manifest = join(pkgDir, "package.json")
const backup = join(pkgDir, "package.json.pack-backup")
const COPIES = ["dist", "LICENSE", "decider", "THIRD_PARTY.md"]

if (pkgDir === root) {
  console.error("pack-js: run it from a package directory (npm runs prepack there)")
  process.exit(1)
}

if (process.argv.includes("--restore")) {
  if (existsSync(backup)) renameSync(backup, manifest)
  for (const name of COPIES) {
    // the decider and THIRD_PARTY.md only exist in a package as copies; never touch a package's own files of that name
    const target = join(pkgDir, name)
    if (name === "LICENSE" && !existsSync(join(root, "LICENSE"))) continue
    rmSync(target, { recursive: true, force: true })
  }
  process.exit(0)
}

// Relative imports ending in .ts (or the compiled tui's), as they appear in emitted or copied JavaScript.
const SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+?)\.tsx?\2/g
const rewrite = (code) => code.replace(SPECIFIER, (_, lead, q, path) => `${lead}${q}${path}.js${q}`)

function emit(srcDir, outDir) {
  for (const entry of readdirSync(srcDir)) {
    const from = join(srcDir, entry)
    const to = join(outDir, entry)
    if (statSync(from).isDirectory()) {
      emit(from, to)
      continue
    }
    mkdirSync(outDir, { recursive: true })
    if (entry.endsWith(".d.ts") || entry.endsWith(".tsx")) continue // a .tsx is shipped as its compiled .js (the TUI)
    if (entry.endsWith(".ts")) {
      const out = ts.transpileModule(readFileSync(from, "utf8"), {
        fileName: from,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, rewriteRelativeImportExtensions: true, sourceMap: false },
      })
      writeFileSync(to.replace(/\.ts$/, ".js"), rewrite(out.outputText))
    } else if (/\.(m?js)$/.test(entry)) {
      writeFileSync(to, rewrite(readFileSync(from, "utf8")))
    } else {
      cpSync(from, to)
    }
  }
}

const toDist = (value) =>
  typeof value === "string" && value.startsWith("./src/") ? value.replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, ".js") : value

function retarget(exports) {
  if (typeof exports === "string") return toDist(exports)
  if (exports && typeof exports === "object") return Object.fromEntries(Object.entries(exports).map(([k, v]) => [k, retarget(v)]))
  return exports
}

const original = readFileSync(manifest, "utf8")
const pkg = JSON.parse(original)
writeFileSync(backup, original)

rmSync(join(pkgDir, "dist"), { recursive: true, force: true })
if (existsSync(join(pkgDir, "src"))) emit(join(pkgDir, "src"), join(pkgDir, "dist"))

pkg.exports = retarget(pkg.exports)
if (pkg.bin) pkg.bin = retarget(pkg.bin)
const files = new Set((pkg.files ?? []).filter((f) => f !== "src"))
files.add("dist")

if (existsSync(join(root, "LICENSE"))) cpSync(join(root, "LICENSE"), join(pkgDir, "LICENSE"))

if (pkg.name === "@omacode/micromanager") {
  // The decider's sources and lock, without its environments, models, training data (data/, train/), runs, tests or the
  // old hand-written unit: what services.ts copies to run it, and nothing a user's machine does not need.
  const source = join(root, "decider")
  cpSync(source, join(pkgDir, "decider"), {
    recursive: true,
    filter: (from) => !/\/(\.venv|models|data|train|tests|__pycache__|runs|decider\.service)(\/|$)/.test(from.slice(source.length)),
  })
  cpSync(join(root, "THIRD_PARTY.md"), join(pkgDir, "THIRD_PARTY.md"))
  files.add("decider")
  files.add("THIRD_PARTY.md")
}

pkg.files = [...files]
writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
console.error(`pack-js: ${pkg.name}: dist/ from src/, exports and bin point at it (${relative(root, pkgDir)})`)
