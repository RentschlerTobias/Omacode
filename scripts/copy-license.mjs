#!/usr/bin/env node
// npm always ships a LICENSE file that sits in the package directory, but a workspace keeps the only copy at the
// repository root. prepack copies it in and postpack removes it again, so every tarball carries the license and the
// tree stays clean.
import { copyFileSync, existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "LICENSE")
const target = join(process.cwd(), "LICENSE")

if (process.argv.includes("--remove")) {
  if (target !== source && existsSync(target)) rmSync(target)
  process.exit(0)
}

if (target === source) process.exit(0) // run from the repository root: nothing to copy
if (!existsSync(source)) {
  console.error(`copy-license: no LICENSE at ${source}`)
  process.exit(1)
}
copyFileSync(source, target)
