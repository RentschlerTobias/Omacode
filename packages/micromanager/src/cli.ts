// Command line: npm run eval -- [--floor 0.8] [--backend cloud] [--journal path]
//               npm run export-dataset -- [--target openjev|gliner|router] [--out file] [--journal path]
//               npm run bench -- [--guard-cases bench/guard_cases.json] [--permission-cases bench/permission_cases.json] [--out path]
//               npm run bench-guards -- [--cases bench/guard_cases.json] [--url http://127.0.0.1:8781/v1/systemone] [--repeat]
//               npm run bench-n7 -- [--cases bench/followup_cases.json]
//               node src/cli.ts status [--project dir] [--all] [--watch]   (an ASCII board of the newest job, or of all)
//               node src/cli.ts memory-adopt [--project dir] [--yes] [slug…]   (take memory kept under old keys, from
//                                                                before renames or moves, into the project)
//               node src/cli.ts sandboxed --dir D -- <command…>  (one command in the writer's sandbox of D, offline;
//                                                                the evolver's candidates run under it, src/evolver.ts)

import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"

import { adopt, adoptCandidates } from "@omacode/context/adopt"
import { MemoryStore } from "@omacode/context/store"

import { DEFAULT_BACKENDS, Decider, cloudKey, makeAskers } from "./backends.ts"
import { benchPath, buildReport, drift, formatBench, formatDrift, formatN7, formatSweep, guardMetrics, loadCases, loadGuardCorpus, loadN7, loadPermissionCorpus, scoreCases, scoreN7, scorePermissions, sweep, writeBench, type Case, type PermissionSeen } from "./bench.ts"
import { GUARD_FLOOR } from "./catalog.ts"
import { loadSettings } from "./config.ts"
import { glinerRows, openJevRows } from "./dataset.ts"
import { evaluate, formatReport } from "./eval.ts"
import { journalPath, readJournal } from "./journal.ts"
import { board } from "./board.ts"
import { listJobs } from "./store.ts"
import { outcomesPath, readOutcomes, routerRows } from "./outcomes.ts"
import { cleanEnv, rulesFor, startSandbox } from "./sandbox.ts"

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

// A word as the shell reads it back: single-quoted unless it needs nothing.
const quote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`)

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === "sandboxed") {
    // Model-written code the evolver measures: it may write its own directory and nothing else, reaches no network
    // beyond the package registries, and gets the cleaned environment. Without a sandbox it does not run at all.
    const dir = flag(args, "dir")
    const sep = args.indexOf("--")
    if (!dir || sep < 0 || sep === args.length - 1) {
      console.error("usage: sandboxed --dir D -- <command…>")
      return 2
    }
    const box = await startSandbox()
    if (!box.available) {
      console.error(`no sandbox here (${box.reason}); the command is not run`)
      return 126
    }
    try {
      // The held-out corpus lies in the plugin's state directory, which the sandbox keeps from every worker; the
      // evaluator measuring the best candidate on it (MM_CORPUS_DIR) may read that one directory, read-only.
      const rules = rulesFor({ role: "code", writer: true, dir, worktree: dir, domains: [] })
      const corpus = process.env.MM_CORPUS === "heldout" ? process.env.MM_CORPUS_DIR : undefined
      const allowed = corpus ? { ...rules, filesystem: { ...rules.filesystem, allowRead: [...rules.filesystem.allowRead, corpus] } } : rules
      const wrapped = await box.wrap(args.slice(sep + 1).map(quote).join(" "), allowed)
      const r = spawnSync("bash", ["-c", wrapped], { cwd: dir, stdio: "inherit", env: cleanEnv(process.env, ["MM_CORPUS", "MM_CORPUS_DIR", "MM_REPEAT"]) })
      return r.status ?? 1
    } finally {
      await box.stop()
    }
  }
  if (command === "memory-adopt") return await memoryAdopt(args)
  if (command === "status") {
    const project = flag(args, "project") ?? process.cwd()
    const draw = () => {
      const jobs = listJobs(project)
      const shown = args.includes("--all") ? jobs : jobs.slice(0, 1)
      const width = Math.max(80, (process.stdout.columns ?? 120) - 2)
      return shown.length ? shown.map((j) => board(j, width)).join("\n\n") : `no micromanager job in ${project}`
    }
    if (!args.includes("--watch")) {
      console.log(draw())
      return 0
    }
    for (;;) {
      process.stdout.write(`\x1b[2J\x1b[H${draw()}\n\n(redraws every 2 s; ctrl-c ends)\n`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  if (command === "bench") {
    // The A2b gate: guards and permission cases through the local decider only, one table, one stored verdict. Local
    // mode by construction, so no key is read and no cloud URL is touched; a bench run never becomes a training row
    // (the journal is not written).
    const config = { ...DEFAULT_BACKENDS }
    const decider = new Decider(config, makeAskers(config, undefined), () => {})
    let guardCases: Case[]
    let permission: PermissionSeen[]
    try {
      guardCases = loadGuardCorpus(flag(args, "guard-cases") ?? "bench/guard_cases.json")
      permission = await scorePermissions(decider, loadPermissionCorpus(flag(args, "permission-cases") ?? "bench/permission_cases.json"))
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return 2
    }
    const guardRows = await scoreCases(decider, guardCases)
    const report = buildReport({ guardCases: guardCases.length, guardRows, permission })
    console.log(formatBench(report))
    console.log(`\nper guard (floor ${GUARD_FLOOR}):`)
    console.log(["guard         positives  flagged  precision  recall", ...guardMetrics(guardRows).map((m) => `${m.guard.padEnd(13)} ${String(m.positives).padStart(9)} ${String(m.flagged).padStart(8)} ${`${(m.precision * 100).toFixed(0)}%`.padStart(10)} ${`${(m.recall * 100).toFixed(0)}%`.padStart(7)}`)].join("\n"))
    try {
      console.log(`\nN7 (not gated, printed for the record):\n${formatN7(await scoreN7(decider, loadN7(flag(args, "n7-cases") ?? "bench/followup_cases.json")))}`)
    } catch (err) {
      console.log(`\nN7: no answers (${err instanceof Error ? err.message : String(err)})`)
    }
    const out = flag(args, "out") ?? benchPath()
    writeBench(report, out)
    console.log(`\nstored: ${out}`)
    return 0
  }
  if (command === "bench-guards") {
    // Guards are local-only; the config is "local", so no cloud client is built and the egress gate is never consulted.
    const config = { ...DEFAULT_BACKENDS, urls: { ...DEFAULT_BACKENDS.urls, gliner: flag(args, "url") ?? DEFAULT_BACKENDS.urls.gliner } }
    const decider = new Decider(config, makeAskers(config, undefined), () => {})
    const cases = loadCases(flag(args, "cases") ?? "bench/guard_cases.json")
    const rows = await scoreCases(decider, cases)
    console.log(formatSweep(sweep(rows)))
    if (args.includes("--repeat")) console.log(`\nrepeat run:\n${formatDrift(drift(rows, await scoreCases(decider, cases)))}`)
    return 0
  }
  if (command === "bench-n7") {
    // N7 follows the configured decider mode, like the plugin: "local" asks the local server and reads no key,
    // "cloud" reads the key. The journal is not written, so bench runs never become training rows.
    //
    // The clients go through the same egress gate as the plugin's (A2-T6), and this process has nobody to show a preview
    // to, so in cloud mode every payload is kept local and nothing leaves the machine. That is not a failure of the
    // bench: it is the gate doing its job where no confirmation can arrive, and it is said out loud.
    const config = { ...DEFAULT_BACKENDS, mode: loadSettings().mode }
    if (config.mode === "cloud") console.error("cloud bench: no preview channel in this process, so every decision is kept local and nothing is sent (A2-T6)")
    const decider = new Decider(config, makeAskers(config, cloudKey(config)), () => {})
    console.log(formatN7(await scoreN7(decider, loadN7(flag(args, "cases") ?? "bench/followup_cases.json"))))
    return 0
  }
  const entries = readJournal(flag(args, "journal") ?? journalPath())
  if (command === "eval") {
    const floor = Number(flag(args, "floor") ?? 0.8)
    console.log(formatReport(evaluate(entries, floor, flag(args, "backend")), floor))
    return 0
  }
  if (command === "export-dataset") {
    const targetName = flag(args, "target") ?? "openjev"
    if (targetName !== "openjev" && targetName !== "gliner" && targetName !== "router") {
      console.error(`unknown target ${targetName}: openjev, gliner or router`)
      return 2
    }
    // router: the outcome log (src/outcomes.ts), one row per task with a trial's attempts joined, not the journal.
    const rows = targetName === "router" ? routerRows(readOutcomes(flag(args, "outcomes") ?? outcomesPath())) : targetName === "gliner" ? glinerRows(entries) : openJevRows(entries)
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")
    const out = flag(args, "out")
    if (out) writeFileSync(out, text)
    else process.stdout.write(text)
    console.error(`${rows.length} ${targetName} rows${out ? ` -> ${out}` : ""}`)
    return 0
  }
  console.error("usage: cli.ts bench|eval|export-dataset|bench-guards|bench-n7 [options]")
  return 2
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))

// memory-adopt: without slugs it proposes the keys that look like this project's (its folder name, its jobs'
// worktrees) and asks before moving them; with slugs it moves exactly those, which is how a key under another name is
// taken in. --yes skips the question, for a script; without a terminal and without --yes nothing is moved.
async function memoryAdopt(args: readonly string[]): Promise<number> {
  // npm run starts in the repository; INIT_CWD is the directory it was called from.
  const project = resolve(flag(args, "project") ?? process.env.INIT_CWD ?? process.cwd())
  const yes = args.includes("--yes")
  const skip = new Set(["--project", flag(args, "project")])
  const named = args.filter((a) => !a.startsWith("--") && !skip.has(a))
  const store = new MemoryStore()
  const { id, candidates } = adoptCandidates(store, project)
  const known = new Map(store.projects().map((p) => [p.project, p]))
  const unknown = named.filter((slug) => !known.has(slug))
  if (unknown.length > 0) {
    console.error(`no memory is kept under ${unknown.join(", ")}; memory-adopt without slugs lists what there is`)
    return 1
  }
  const slugs = named.length > 0 ? named.filter((slug) => slug !== id) : candidates.map((c) => c.slug)
  console.log(`project ${project}\nits memory key: ${id} (${known.get(id)?.entries ?? 0} entries)\n`)
  if (slugs.length === 0) {
    console.log(named.length > 0 ? "nothing to adopt" : "no old keys look like this project's. Name one to take it in: memory-adopt <slug>")
    return 0
  }
  for (const slug of slugs) {
    const c = candidates.find((x) => x.slug === slug)
    const p = known.get(slug)!
    console.log(`  ${slug}  ${p.entries} entries, last ${p.updated.slice(0, 10)}${c ? `  (${c.why})` : ""}`)
    for (const line of c?.sample ?? []) console.log(`      · ${line}`)
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log("\nnothing moved: run it in a terminal to be asked, or pass --yes")
      return 0
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`\nmove these ${slugs.length} keys into ${id}? [y/N] `)).trim().toLowerCase()
    rl.close()
    if (answer !== "y" && answer !== "yes" && answer !== "j" && answer !== "ja") {
      console.log("nothing moved")
      return 0
    }
  }
  const { moved } = adopt(store, project, slugs)
  console.log(`moved ${moved} entries into ${id}`)
  return 0
}
