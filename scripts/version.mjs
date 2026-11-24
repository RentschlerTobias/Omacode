#!/usr/bin/env node
// Sets one version on every workspace package and on every @omacode/* dependency between them, so the packages are
// released together and always install as a set.
//
//   node scripts/version.mjs 1.0.0
//
// Afterwards: `npm install --package-lock-only` to bring the lockfile along, then the release (scripts/release.mjs).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/version.mjs <version>, e.g. 1.0.0 or 1.0.0-rc.1")
  process.exit(1)
}

const packages = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "packages")
for (const dir of readdirSync(packages)) {
  const file = join(packages, dir, "package.json")
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, "utf8"))
  pkg.version = version
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) if (name.startsWith("@omacode/")) pkg[field][name] = version
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name} ${version}`)
}
