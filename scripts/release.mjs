#!/usr/bin/env node
// Publishes the workspace packages in dependency order, so no package is on the registry before the ones it depends
// on. `--dry` (the default) typechecks, runs the fast suite and prints every tarball; `--publish` uploads and needs a
// 2FA code per package, or an NPM_TOKEN with bypass 2FA.
//
//   node scripts/release.mjs             # checks + `npm publish --dry-run` for all 8
//   node scripts/release.mjs --publish   # the real thing
import { spawnSync } from "node:child_process"

// Dependencies first: @omacode/micromanager pulls @omacode/tui (its progress helpers), which pulls state and context.
const ORDER = [
  "@omacode/core",
  "@omacode/guard",
  "@omacode/sandbox",
  "@omacode/state",
  "@omacode/context",
  "@omacode/tui",
  "@omacode/micromanager",
  "@omacode/full",
]

const publish = process.argv.includes("--publish")

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error) {
    console.error(`release: ${command} failed: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`release: \`${command} ${args.join(" ")}\` exited with ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

run("npm", ["run", "typecheck"])
run("npm", ["run", "test:min"])

for (const name of ORDER) {
  run("npm", ["publish", "--workspace", name, "--access", "public", ...(publish ? [] : ["--dry-run"])])
}

console.log(publish ? "\nrelease: published every package" : "\nrelease: dry run, nothing was published (pass --publish)")
