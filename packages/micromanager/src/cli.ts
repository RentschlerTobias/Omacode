// Command line: npm run eval -- [--floor 0.8] [--backend cloud] [--journal path]
//               npm run export-dataset -- [--target openjev|gliner|router] [--out file] [--journal path]
//               npm run bench -- [--guard-cases bench/guard_cases.json] [--permission-cases bench/permission_cases.json] [--out path]
//               npm run bench-guards -- [--cases bench/guard_cases.json] [--url http://127.0.0.1:8781/v1/systemone] [--repeat]
//               npm run bench-n7 -- [--cases bench/followup_cases.json]
//               node src/cli.ts status [--project dir] [--all] [--watch]   (an ASCII board of the newest job, or of all)
//               node src/cli.ts memory-adopt [--project dir] [--yes] [slug…]   (take memory kept under old keys, from
//                                                                before renames or moves, into the project)
//               node src/cli.ts migrate [--project dir] [--apply]   (move the state directory from an old name to
//                                                                the current one, core/paths.ts; a dry run without --apply)
//               node src/cli.ts migrate --user [--apply]   (the same for the user's state, memory and settings files)
//               node src/cli.ts synth-guards [--model provider/model] [--per 25] [--public] [--topics g/id,…] [--langs de,en]
//                                                                [--relabel] [--rows] [--out decider/data/guards.jsonl]
//               node src/cli.ts synth-entities [--model provider/model] [--per 20] [--contexts a,b] [--langs de,en]
//                                                                [--out decider/data/entities.jsonl]
//                                                                (P6-T3a: made-up names and addresses with their spans)
//                                                                (P6-T2: synthetic and public training cases for the guards)
//               node src/cli.ts services install [--embedding 0.6b|4b|8b] [--replace] | status | mode <service> <on|auto|off> | device <service> <cpu|Vulkan0|…> | idle <minutes> | remove [--purge]
//                                                                (A6: the decider and the embedding service as one user service)
//               node src/cli.ts tools status | gpus | install <hyperframes|manim|comfyui>[,…] [--gpu <id>] | register comfyui [--gpu <id>] | ask
//                                                                (A6-T6/T7: the optional creative tools, pinned, into the home)
//               node src/cli.ts sandboxed --dir D -- <command…>  (one command in the writer's sandbox of D, offline;
//                                                                the evolver's candidates run under it, src/evolver.ts)

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname as dir, resolve } from "node:path"
import { createInterface } from "node:readline/promises"

import { adopt, adoptCandidates } from "@omacode/context/adopt"
import { MemoryStore } from "@omacode/context/store"
import { applyMigration, applyUserMigration, planMigration, planUserMigration } from "@omacode/state/migrate"

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
import { servicesView, setIdleMinutes, setServiceDevice, setServiceMode } from "@omacode/core/service-control"
import { SERVICE_MODES, type Mode } from "@omacode/core/supervisor"
import { EMBEDDING_SIZES, install as installServices, remove as removeServices, status as servicesStatus, type EmbeddingSize } from "./services.ts"
import { exec } from "./worktree/git.ts"
import { registerComfy } from "./services.ts"
import { comfyLaunch, comfyPython, comfyWorkspace, home, detect as detectTools, gpus as toolGpus, installSteps, TOOL_INFO, TOOL_NAMES, torchChecks, type Gpu, type Step, type ToolName } from "./creative-tools.ts"
import { ENTITY_CONTEXTS, entityRows, normal, opencodeAsk, publicCases, relabel, synthesize, synthesizeEntities, TOPICS, trainingRows, type Case as GuardCase, type EntityCase } from "./synth.ts"

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
  if (command === "synth-guards") return await synthGuards(args)
  if (command === "synth-entities") return await synthEntities(args)
  if (command === "tools") return await tools(args)
  if (command === "services") {
    const [verb] = args
    if (verb === "status") {
      console.log(servicesStatus())
      return 0
    }
    if (verb === "mode") {
      const [, name, mode] = args
      const known = servicesView().services.map((v) => v.name)
      if (!name || !known.includes(name) || !SERVICE_MODES.includes(mode as Mode)) {
        console.error(`usage: services mode <${known.join("|") || "decider|embedding"}> <${SERVICE_MODES.join("|")}>`)
        return 1
      }
      setServiceMode(name, mode as Mode)
      console.log(`${name}: ${mode} (the supervisor applies it within a second)`)
      return 0
    }
    if (verb === "device") {
      const [, name, device] = args
      const service = servicesView().services.find((v) => v.name === name)
      const ids = service?.devices?.map((d) => d.id) ?? []
      const only = service?.devices?.length === 1 ? service.devices[0] : undefined
      if (only) {
        console.error(`${service!.name}: ${only.note ?? `runs on ${only.name} only`}`)
        return 1
      }
      if (!service || ids.length < 2 || !device || !ids.includes(device)) {
        const choices = servicesView().services.filter((v) => (v.devices?.length ?? 0) > 1).map((v) => `${v.name}: ${v.devices!.map((d) => `${d.id} (${d.name})`).join(", ")}`)
        console.error(`usage: services device <service> <device>\n${choices.join("\n") || "no service with a choice of device (is omacode-services running?)"}`)
        return 1
      }
      setServiceDevice(service.name, device)
      console.log(`${name}: moving to ${device}${service.state === "running" ? " (restarts now)" : ""}`)
      return 0
    }
    if (verb === "idle") {
      const minutes = Number(args[1])
      if (!Number.isFinite(minutes) || minutes <= 0) {
        console.error("usage: services idle <minutes>")
        return 1
      }
      setIdleMinutes(minutes)
      console.log(`services in auto stop after ${minutes} min without a request`)
      return 0
    }
    if (verb === "remove") {
      console.log(await removeServices(exec, { purge: args.includes("--purge") }))
      return 0
    }
    if (verb === "install") {
      const size = flag(args, "embedding")
      if (size && !(size in EMBEDDING_SIZES)) {
        console.error(`--embedding must be one of ${Object.keys(EMBEDDING_SIZES).join(", ")}`)
        return 1
      }
      const r = await installServices(exec, { ...(size ? { embedding: size as EmbeddingSize } : {}), replace: args.includes("--replace"), log: (line) => console.log(line) })
      if (!r.ok) console.error(r.text)
      return r.ok ? 0 : 1
    }
    console.error("usage: services install [--embedding 0.6b|4b|8b] [--replace] | status | mode <service> <on|auto|off> | device <service> <cpu|Vulkan0|…> | idle <minutes> | remove [--purge]")
    return 1
  }
  if (command === "migrate" && args.includes("--user")) {
    const plan = planUserMigration()
    const apply = args.includes("--apply")
    if (plan.moves.length === 0 && plan.problems.length === 0) {
      console.log("the user's state, memory and settings are on their current names; nothing to move")
      return 0
    }
    for (const move of plan.moves) console.log(`${apply ? "" : "dry run: "}${move.what}: ${move.from} → ${move.to}`)
    for (const problem of plan.problems) console.log(`  cannot move: ${problem}`)
    for (const warning of plan.warnings) console.log(`  note: ${warning}`)
    if (!apply) {
      if (!plan.problems.length) console.log("run it again with --apply to move")
      return plan.problems.length ? 1 : 0
    }
    const result = applyUserMigration(plan)
    console.log(result.text)
    return plan.problems.length ? 1 : 0
  }
  if (command === "migrate") {
    const project = resolve(flag(args, "project") ?? process.env.INIT_CWD ?? process.cwd())
    const plan = planMigration(project)
    console.log(`project ${project}`)
    if (!plan.from) {
      console.log(plan.note)
      return plan.problems.length ? 1 : 0
    }
    console.log(`${args.includes("--apply") ? "" : "dry run: "}${plan.note}`)
    for (const problem of plan.problems) console.log(`  cannot move now: ${problem}`)
    if (!args.includes("--apply")) {
      if (!plan.problems.length) console.log("run it again with --apply to move")
      return plan.problems.length ? 1 : 0
    }
    const result = applyMigration(plan)
    console.log(result.text)
    return result.moved ? 0 : 1
  }
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

// synth-guards (P6-T2): adds cases to the guards' training set, never removing one; a text already in the file is not
// added again. --public adds the public dataset instead of synthetic cases. --rows writes the GLiNER2 training rows next
// to it (guards.rows.jsonl).
async function synthGuards(args: readonly string[]): Promise<number> {
  const out = resolve(flag(args, "out") ?? "decider/data/guards.jsonl")
  const model = flag(args, "model") ?? "opencode-go/deepseek-v4.1-flash"
  const have: GuardCase[] = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GuardCase) : []
  const seen = new Set(have.map((c) => normal(c.text)))
  mkdirSync(dir(out), { recursive: true })
  const ask = opencodeAsk(model, dir(out))
  const log = (line: string) => console.error(line)
  if (args.includes("--relabel")) {
    const r = await relabel(ask, have, Number(flag(args, "concurrency") ?? 4), log)
    writeFileSync(out, r.cases.map((c) => JSON.stringify(c)).join("\n") + "\n")
    if (args.includes("--rows")) writeFileSync(out.replace(/\.jsonl$/, ".rows.jsonl"), trainingRows(r.cases).map((row) => JSON.stringify(row)).join("\n") + "\n")
    console.log(`relabelled: ${r.changed} cases changed a label, ${r.dropped} dropped, ${r.failed} batches unanswered; ${r.cases.length} in ${out}`)
    return 0
  }
  const { cases, stats } = args.includes("--public")
    ? await publicCases(ask, fetch, seen, log, Number(flag(args, "concurrency") ?? 4))
    : await synthesize(ask, model, {
      per: Number(flag(args, "per") ?? 25),
      seen,
      log,
      concurrency: Number(flag(args, "concurrency") ?? 4),
      // --topics harmful/people,harmful/poison and --langs de: fill in batches the model refused before.
      ...(flag(args, "topics") ? { topics: TOPICS.filter((t) => flag(args, "topics")!.split(",").includes(`${t.guard}/${t.id}`)) } : {}),
      ...(flag(args, "langs") ? { langs: flag(args, "langs")!.split(",") as ("de" | "en")[] } : {}),
    })
  const all = [...have, ...cases]
  writeFileSync(out, all.map((c) => JSON.stringify(c)).join("\n") + "\n")
  if (args.includes("--rows")) writeFileSync(out.replace(/\.jsonl$/, ".rows.jsonl"), trainingRows(all).map((r) => JSON.stringify(r)).join("\n") + "\n")
  console.log(`${stats.kept} new cases (${stats.generated} written, ${stats.disagreed} dropped by the labelling pass, ${stats.duplicates} duplicates, ${stats.failedCalls} failed calls); ${all.length} in ${out}`)
  return 0
}

// synth-entities (P6-T3a): adds made-up texts with names and addresses to the entity training set, never removing one,
// and writes the GLiNER2 rows beside it (entities.rows.jsonl).
async function synthEntities(args: readonly string[]): Promise<number> {
  const out = resolve(flag(args, "out") ?? "decider/data/entities.jsonl")
  const model = flag(args, "model") ?? "opencode-go/deepseek-v4.1-flash"
  const have: EntityCase[] = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as EntityCase) : []
  mkdirSync(dir(out), { recursive: true })
  const { cases, stats } = await synthesizeEntities(opencodeAsk(model, dir(out)), model, {
    per: Number(flag(args, "per") ?? 20),
    seen: new Set(have.map((c) => normal(c.text))),
    concurrency: Number(flag(args, "concurrency") ?? 4),
    log: (line) => console.error(line),
    // --contexts contract,data and --langs de: fill in batches whose check went unanswered before.
    ...(flag(args, "contexts") ? { contexts: ENTITY_CONTEXTS.filter((c) => flag(args, "contexts")!.split(",").includes(c.id)) } : {}),
    ...(flag(args, "langs") ? { langs: flag(args, "langs")!.split(",") as ("de" | "en")[] } : {}),
  })
  const all = [...have, ...cases]
  writeFileSync(out, all.map((c) => JSON.stringify(c)).join("\n") + "\n")
  writeFileSync(out.replace(/\.jsonl$/, ".rows.jsonl"), entityRows(all).map((r) => JSON.stringify(r)).join("\n") + "\n")
  console.log(`${stats.kept} new cases (${stats.generated} written, ${stats.disagreed} dropped by the checks, ${stats.duplicates} duplicates, ${stats.failedCalls} unchecked batches); ${all.length} in ${out}`)
  return 0
}

// `tools status | gpus | install <tool>[,<tool>…] [--gpu <id>] | ask`: the optional creative tools (creative-tools.ts).
// ask is install.sh's question round: each tool with what it is for and whether it is there, then y/N; ComfyUI also
// asks for the device among the ones found.
async function tools(args: string[]): Promise<number> {
  const [verb, list] = args
  if (verb === "status") {
    for (const t of await detectTools(exec)) console.log(`${TOOL_INFO[t.name].title.padEnd(12)} ${t.found ? `found ${t.version ?? ""}${t.where ? ` in ${t.where}` : ""}` : "not found"}`)
    return 0
  }
  if (verb === "gpus") {
    for (const g of await toolGpus(exec)) console.log(`${g.id.padEnd(9)} ${g.name}${g.note ? ` (${g.note})` : ""}`)
    return 0
  }
  if (verb === "install") {
    const names = (list ?? "").split(",").map((x) => x.trim()).filter(Boolean)
    const bad = names.filter((n) => !(TOOL_NAMES as readonly string[]).includes(n))
    if (!names.length || bad.length) {
      console.error(`usage: tools install <${TOOL_NAMES.join("|")}>[,…] [--gpu nvidia|amd|amd-igpu|cpu]${bad.length ? `\nunknown: ${bad.join(", ")}` : ""}`)
      return 1
    }
    const found = await toolGpus(exec)
    const wanted = flag(args, "gpu")
    const gpu = wanted ? found.find((g) => g.id === wanted) : found[0]
    if (wanted && !gpu) {
      console.error(`no ${wanted} here; found: ${found.map((g) => g.id).join(", ")}`)
      return 1
    }
    let failed = 0
    for (const name of names as ToolName[]) failed += (await installTool(name, gpu)) ? 0 : 1
    return failed ? 1 : 0
  }
  if (verb === "register") {
    if (list !== "comfyui") {
      console.error("usage: tools register comfyui [--gpu <id>]")
      return 1
    }
    if (!(await detectTools(exec)).find((t) => t.name === "comfyui")?.found) {
      console.error(`no ComfyUI in ${comfyWorkspace(home())}`)
      return 1
    }
    const found = await toolGpus(exec)
    const wanted = flag(args, "gpu")
    const gpu = wanted ? found.find((g) => g.id === wanted) : found[0]
    if (!gpu) {
      console.error(`no ${wanted} here; found: ${found.map((g) => g.id).join(", ")}`)
      return 1
    }
    return registerComfyTool(gpu) ? 0 : 1
  }
  if (verb === "ask") {
    if (!process.stdin.isTTY) {
      console.log("no terminal: no optional tools asked about (install.sh --with hyperframes,manim,comfyui installs them)")
      return 0
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const yes = async (q: string) => /^(y|yes|j|ja)$/i.test((await rl.question(`${q} [y/N] `)).trim())
      console.log("\nOptional tools (each is installed into your home at a pinned version; all can be added later with npm run tools -- install <name>):")
      const there = await detectTools(exec)
      const picked: { name: ToolName; gpu?: Gpu }[] = []
      for (const t of there) {
        const info = TOOL_INFO[t.name]
        console.log(`\n${info.title}: ${info.what}. ${info.size}.`)
        if (t.found) {
          console.log(`  found ${t.version ?? ""}${t.where ? ` in ${t.where}` : ""}`)
          continue
        }
        if (!(await yes(`  install ${info.title}?`))) continue
        if (t.name !== "comfyui") {
          picked.push({ name: t.name })
          continue
        }
        const devices = await toolGpus(exec)
        devices.forEach((g, i) => console.log(`  ${i + 1}) ${g.name}${g.note ? ` — ${g.note}` : ""}`))
        const answer = (await rl.question(`  run ComfyUI on [1-${devices.length}, default 1]: `)).trim()
        const gpu = devices[Math.max(0, Math.min(devices.length - 1, (Number(answer) || 1) - 1))]!
        picked.push({ name: "comfyui", gpu })
      }
      rl.close()
      let failed = 0
      for (const p of picked) failed += (await installTool(p.name, p.gpu)) ? 0 : 1
      return failed ? 1 : 0
    } finally {
      rl.close()
    }
  }
  console.error(`usage: tools status | gpus | install <${TOOL_NAMES.join("|")}>[,…] [--gpu <id>] | ask`)
  return 1
}

// Runs a tool's steps with their output on the terminal; false at the first one that fails.
async function installTool(name: ToolName, gpu?: Gpu): Promise<boolean> {
  const step = (s: Step, quiet = false) => {
    if (!quiet) console.log(`→ ${s.say}`)
    return spawnSync(s.cmd, [...s.args], { cwd: s.cwd, env: { ...process.env, ...s.env }, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" })
  }
  for (const s of installSteps(name, undefined, name === "comfyui" ? gpu : undefined)) {
    const r = step(s)
    if (r.status !== 0) {
      console.error(`${TOOL_INFO[name].title}: "${s.say}" failed${r.error ? ` (${r.error.message})` : ""}`)
      return false
    }
  }
  if (name !== "comfyui") {
    console.log(`${TOOL_INFO[name].title} installed`)
    return true
  }
  return registerComfyTool(gpu)
}

// After a ComfyUI install, or for one already there: check that its PyTorch sees the GPU, and add it to
// omacode-services on that GPU (or the CPU, when it does not).
function registerComfyTool(gpu?: Gpu): boolean {
  const step = (s: Step) => spawnSync(s.cmd, [...s.args], { cwd: s.cwd, env: { ...process.env, ...s.env }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
  let env: Readonly<Record<string, string>> = {}
  let seenGpu = false
  const checks = gpu ? torchChecks(gpu) : []
  for (const [i, c] of checks.entries()) {
    console.log(`→ ${c.say}`)
    const r = step(c)
    const seen = r.status === 0 && r.stdout.startsWith("gpu")
    console.log(`  ${seen ? `yes: ${r.stdout.slice(4).trim()}` : "no"}`)
    if (seen) {
      env = c.env ?? {}
      seenGpu = true
      break
    }
    if (i === checks.length - 1) console.log(`  ComfyUI is installed but will run on the CPU: its PyTorch does not see ${gpu!.name}`)
  }
  const comfy = { python: comfyPython(), workspace: comfyWorkspace(home()), ...(gpu && gpu.id !== "cpu" && seenGpu ? { gpu: { id: gpu.id, name: gpu.name, ...(Object.keys(env).length ? { env } : {}) } } : {}) }
  if (registerComfy(comfy)) {
    const restarted = spawnSync("systemctl", ["--user", "try-restart", "omacode-services.service"], { stdio: "ignore" })
    console.log(`ComfyUI installed and added to omacode-services on :8188, started by its first request${restarted.status === 0 ? "" : " (restart omacode-services to load it)"}; /services switches it`)
  } else {
    console.log(`ComfyUI installed; start it with:\n  ${comfyLaunch(env)}\n(or install omacode-services, npm run services -- install, and run this again to have it started on demand)`)
  }
  return true
}
