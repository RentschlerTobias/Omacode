import assert from "node:assert/strict"
import { test } from "node:test"

import { DEFAULT_BACKENDS, Decider, backendNotes, cloudClient, cloudKey, label, makeAskers, rulesDecider, type Asker, type BackendName } from "../packages/micromanager/src/backends.ts"
import { DecisionClient, DeciderError, type Question } from "../packages/micromanager/src/decider.ts"
import { EgressRefused, type EgressRequest } from "../packages/micromanager/src/egress.ts"
import { glinerRows, openJevRows, renderState, splitOf } from "../packages/micromanager/src/dataset.ts"
import { evaluate } from "../packages/micromanager/src/eval.ts"
import type { Decision } from "../packages/micromanager/src/decider.ts"
import type { Entry } from "../packages/micromanager/src/journal.ts"

const QUESTIONS: Record<string, Question> = {
  role: { type: "choice", instructions: "Which role fits?", criteria: { code: "writes code", explore: "reads only" } },
  harmful: { type: "noul", instructions: "This task asks for help to hurt people." },
}

const fixed = (answers: Decision["answers"], calls: string[] = [], name = "x"): Asker => ({
  async ask(state) {
    calls.push(`${name}:${state}`)
    return { answers, model: name, latencyMs: 5 }
  },
})
const failing: Asker = { async ask() { throw new Error("down") } }

const jevAnswers: Decision["answers"] = {
  role: { type: "choice", choice: "code", confidence: 0.9, probabilities: { code: 0.9, explore: 0.1 } },
  harmful: { type: "noul", noul: 0.05 },
}

function decider(askers: Partial<Record<BackendName, Asker>>, shadow?: BackendName) {
  const entries: Entry[] = []
  // The cloud semantics of the table below: a node's backend, the guards local, shadow mode on.
  const d = new Decider({ ...DEFAULT_BACKENDS, mode: "cloud", shadow }, { rules: { async ask() { return { answers: {}, model: "rules", latencyMs: 0 } } }, ...askers }, (e) => entries.push(e))
  return { d, entries }
}

test("each node uses its backend; G0 and local-only jobs never reach the cloud", () => {
  const { d } = decider({ cloud: failing, gliner: failing })
  assert.equal(d.backendFor("N5"), "cloud")
  assert.equal(d.backendFor("G0"), "gliner")
  assert.equal(d.backendFor("N5", true), "gliner")
  const { d: noGliner } = decider({ cloud: failing })
  assert.equal(noGliner.backendFor("G0"), "rules", "rather rules than the cloud")
  assert.equal(noGliner.backendFor("N5", true), "rules")
})

test("a decision is journaled with its state object, questions and answers", async () => {
  const { d, entries } = decider({ cloud: fixed(jevAnswers) })
  const asked = await d.ask("N5", { task: "Add a flag" }, QUESTIONS, { job: "job-1", task: "T1" })
  assert.equal(asked.backend, "cloud")
  const e = entries[0]!
  assert.equal(e.kind, "decision")
  assert.equal(e.id, asked.id)
  assert.deepEqual(e.state, { task: "Add a flag" })
  assert.equal(e.task, "T1")
})

test("a failing backend falls back to rules and says why", async () => {
  const { d, entries } = decider({ cloud: failing })
  const asked = await d.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal(asked.backend, "rules")
  assert.equal(asked.error, "down")
  assert.deepEqual(asked.decision.answers, {})
  assert.equal(entries[0]!.backend, "rules")
})

test("shadow mode journals the local backend beside the cloud one, and never runs in local mode", async () => {
  const calls: string[] = []
  const gl = fixed({ role: { type: "choice", choice: "explore", confidence: 0.7, probabilities: { code: 0.3, explore: 0.7 } } }, calls, "gliner")
  const { d, entries } = decider({ cloud: fixed(jevAnswers, calls, "cloud"), gliner: gl }, "gliner")
  await d.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal((entries[0]!.shadow as { backend: string }).backend, "gliner")
  // G0 already runs on gliner: the same backend would answer twice.
  const { d: d2, entries: e2 } = decider({ cloud: fixed(jevAnswers, calls, "cloud"), gliner: gl }, "gliner")
  await d2.ask("G0", { text: "secret" }, QUESTIONS)
  assert.equal(e2[0]!.backend, "gliner")
  assert.equal(e2[0]!.shadow, undefined, "no second backend for a guard")
  // Local mode: nothing leaves the machine, so the cloud side of a shadow is never asked.
  const cloudCalls = calls.filter((c) => c.startsWith("cloud:")).length
  const local = new Decider({ ...DEFAULT_BACKENDS, mode: "local", shadow: "cloud" }, { cloud: fixed(jevAnswers, calls, "cloud"), gliner: gl }, () => {})
  await local.ask("N5", { task: "x" }, QUESTIONS)
  assert.equal(calls.filter((c) => c.startsWith("cloud:")).length, cloudCalls, "no cloud request in local mode")
})

test("local mode builds no cloud client and never reads a key", () => {
  let reads = 0
  const read = () => {
    reads++
    throw new Error("the keyring was read")
  }
  const local = { ...DEFAULT_BACKENDS, mode: "local" as const }
  assert.equal(cloudKey(local, read), undefined)
  assert.equal(reads, 0, "a local start touches neither JEV_API_KEY nor the keyring")
  const askers = makeAskers(local, "a-key-in-the-environment", undefined, () => false)
  assert.equal(askers.cloud, undefined, "no cloud client in local mode")
  assert.ok(askers.gliner, "the local server is the one that answers")
  const d = new Decider(local, askers, () => {})
  assert.equal(d.backendFor("N5"), "gliner", "the cloud default is demoted to the local chain")
  assert.equal(d.backendFor("G0"), "gliner")
})

test("cloud mode reads the key and builds the cloud client", () => {
  let reads = 0
  const read = () => {
    reads++
    return "k"
  }
  const cloud = { ...DEFAULT_BACKENDS, mode: "cloud" as const }
  assert.equal(cloudKey(cloud, read), "k")
  assert.equal(reads, 1)
  assert.ok(makeAskers(cloud, "k").cloud)
})

test("the cloud backend is called cloud; an old typesafe id is refused", () => {
  assert.equal(DEFAULT_BACKENDS.urls.cloud, "https://api.typesafe.ai/v1/systemone")
  assert.equal("typesafe" in DEFAULT_BACKENDS.urls, false)
  // Backends are code (DEFAULT_BACKENDS), not a config field, so an old name has nowhere to be read from: a stale
  // node override is refused rather than aliased, so the journal can never mix two names for one backend.
  const d = new Decider({ ...DEFAULT_BACKENDS, mode: "cloud", nodes: { N5: "typesafe" as unknown as BackendName } }, { cloud: fixed(jevAnswers) }, () => {})
  assert.equal(d.backendFor("N5"), "rules")
})

test("openjev is off when no server is installed, and the reason is stated", () => {
  assert.equal(makeAskers(DEFAULT_BACKENDS, undefined, undefined, () => false).openjev, undefined)
  assert.match(backendNotes(DEFAULT_BACKENDS, () => false).join("\n"), /openjev: no Open-Jev server installed/)
  assert.deepEqual(backendNotes(DEFAULT_BACKENDS, () => true), [])
  assert.ok(makeAskers(DEFAULT_BACKENDS, undefined, undefined, () => true).openjev)
})

test("the client is DecisionClient and the old names are gone", async () => {
  const mod = (await import("../packages/micromanager/src/decider.ts")) as Record<string, unknown>
  assert.equal(typeof mod.DecisionClient, "function")
  assert.equal(typeof mod.DeciderError, "function")
  assert.equal("Jev" in mod, false)
  assert.equal("JevError" in mod, false)
})

async function journalWithLabels(): Promise<Entry[]> {
  const { d, entries } = decider({ cloud: fixed(jevAnswers) })
  const a = await d.ask("N5", { task: "Add a --csv flag" }, QUESTIONS, { job: "job-1", task: "T1" })
  await d.ask("N5", { task: "Map the repo" }, QUESTIONS, { job: "job-1", task: "T2" })
  label(a.id, "role", "explore", "user_override", (e) => entries.push(e))
  return entries
}

test("Open-Jev rows: a label beats Jev's probabilities; groups decide the split", async () => {
  const rows = openJevRows(await journalWithLabels())
  assert.equal(rows.length, 4)
  const overridden = rows.find((r) => r.id && String(r.id).endsWith("/role") && r.group_id === "T1")!
  assert.deepEqual(overridden.target, [0, 1])
  assert.equal((overridden.metadata as { label_source: string }).label_source, "user_override")
  const soft = rows.find((r) => String(r.id).endsWith("/role") && r.group_id === "T2")!
  assert.deepEqual(soft.target, [0.9, 0.1])
  const noul = rows.find((r) => String(r.id).endsWith("/harmful"))!
  assert.deepEqual(noul.options, ["no", "yes"])
  assert.equal(splitOf("T1"), splitOf("T1"))
})

test("GLiNER rows carry hard labels in the oc-voice format; the state text puts the task first", async () => {
  const rows = glinerRows(await journalWithLabels())
  const first = rows[0] as { input: string; output: { classifications: { task: string; true_label: string; labels: object }[] } }
  assert.match(first.input, /^task: Add a --csv flag/)
  assert.equal(first.output.classifications[0]!.true_label, "explore")
  assert.equal(renderState({ other: 1, text: "hello" }), "text: hello\nother: 1")
})

test("the eval harness reports automatic and wrong rates per question", async () => {
  const entries = await journalWithLabels()
  const [role] = evaluate(entries, 0.8)
  assert.deepEqual({ key: role!.key, labeled: role!.labeled, automatic: role!.automatic, wrong: role!.wrong }, { key: "N5.role", labeled: 1, automatic: 1, wrong: 1 })
  assert.equal(evaluate(entries, 0.95)[0]!.automatic, 0)
})

// -------------------------------------------------------------------------------------------------------------------
// A2-T6: the egress gate. Every remote payload is redacted, previewed and confirmed before it may leave; a local
// (loopback) server never sees the gate at all.

const CLOUD_URL = "https://api.example.com/v1/systemone"

// A fake cloud transport: it records every body it was sent, and answers with what the test needs.
function transport(answers: Record<string, unknown> = {}): { bodies: { model?: string; state?: string; questions?: unknown }[]; fetch: typeof fetch } {
  const bodies: { model?: string; state?: string; questions?: unknown }[] = []
  const fake = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as { model?: string; state?: string; questions?: unknown })
    return Response.json({ model: "cloud", answers })
  }) as unknown as typeof fetch
  return { bodies, fetch: fake }
}

const HARMLESS = { harmless: { type: "noul", noul: 0.94 } }

test("a remote payload arrives redacted, and the preview showed exactly what left", async () => {
  const seen: EgressRequest[] = []
  const { bodies, fetch } = transport(HARMLESS)
  const client = new DecisionClient("k", {
    url: CLOUD_URL,
    fetch,
    egress: { secrets: ["s3cr3t-from-the-env-file"], confirm: async (r) => { seen.push(r); return "send" } },
  })
  const state = JSON.stringify({ text: "Mail anna.weber@firma.de about /home/alice/Repos/proj, token sk-abcdefghijklmnopqrstuv, host 10.0.0.7, value s3cr3t-from-the-env-file" })
  const got = await client.ask(state, { harmless: { type: "noul", instructions: "It is harmless." } }, { node: "N13.grant", job: "job-1" })

  assert.equal(bodies.length, 1, "one request, and only after the answer")
  const sent = String(bodies[0]!.state)
  for (const raw of ["anna.weber@firma.de", "/home/alice", "sk-abcdefghijklmnopqrstuv", "10.0.0.7", "s3cr3t-from-the-env-file"]) {
    assert.equal(sent.includes(raw), false, `${raw} must not leave`)
  }
  assert.match(sent, /email1@redacted\.invalid/)
  assert.match(sent, /PATH_1/)
  assert.match(sent, /IP_1/)
  assert.match(sent, /<secret>/)
  assert.equal(seen[0]?.text, sent, "the preview is the payload, not a copy that could drift")
  assert.equal(seen[0]?.node, "N13.grant")
  assert.deepEqual([...(seen[0]?.replaced ?? [])].sort(), ["email", "home-path", "ipv4", "known", "sk-key"])
  assert.equal(got.sent, sent, "the client reports the text it sent, so the journal can keep it")
  assert.equal(got.egress?.verdict, "send")
  assert.equal(got.answers.harmless?.type, "noul")
})

test("a remote client with no preview channel sends nothing at all", async () => {
  const { bodies, fetch } = transport(HARMLESS)
  // The CLI's shape: a cloud client built without a confirm function. No confirmation, no request.
  const client = new DecisionClient("k", { url: CLOUD_URL, fetch })
  await assert.rejects(
    client.ask(JSON.stringify({ text: "run the tests" }), { harmless: { type: "noul", instructions: "fine" } }),
    (err: unknown) => err instanceof EgressRefused && err.outcome.verdict === "no-channel",
  )
  assert.equal(bodies.length, 0)
  // The CLI's construction (`makeAskers` without a confirm function) is the same client: it refuses too.
  const cli = cloudClient({ ...DEFAULT_BACKENDS, mode: "cloud" }, "k", fetch)
  assert.ok(cli)
  await assert.rejects(cli.ask("{}", {}), EgressRefused)
  assert.equal(bodies.length, 0)
})

test("a sensitive payload needs a confirmation, and none means no request", async () => {
  const { bodies, fetch } = transport(HARMLESS)
  const previews: EgressRequest[] = []
  const asked = new DecisionClient("k", {
    url: CLOUD_URL,
    fetch,
    egress: { names: true, confirm: async (r) => { previews.push(r); return r.unredactable ? "keep-local" : "send" } },
  })
  await assert.rejects(
    asked.ask(JSON.stringify({ text: "summarise the dossier", sensitive: true }), { harmless: { type: "noul", instructions: "fine" } }),
    (err: unknown) => err instanceof EgressRefused && err.outcome.verdict === "keep-local",
  )
  assert.equal(previews[0]?.unredactable, true)
  assert.match(String(previews[0]?.why), /sensitive guard flag/)
  assert.equal(bodies.length, 0, "nothing left")

  // The same payload, confirmed: it goes, and the preview says why it was uncertain even with the name detector on.
  const allowed = new DecisionClient("k", { url: CLOUD_URL, fetch, egress: { names: true, confirm: async () => "send" } })
  await allowed.ask(JSON.stringify({ text: "summarise the dossier", sensitive: true }), { harmless: { type: "noul", instructions: "fine" } })
  assert.equal(bodies.length, 1)
})

test("a >20-word payload that redaction left unchanged is unredactable", async () => {
  const { bodies, fetch } = transport(HARMLESS)
  const previews: EgressRequest[] = []
  const client = new DecisionClient("k", { url: CLOUD_URL, fetch, egress: { names: true, confirm: async (r) => { previews.push(r); return "keep-local" } } })
  const plain = "The parser should skip the empty line before the header and keep the trailing comment in the output file as it is today"
  assert.equal(plain.split(" ").length > 20, true, "the fixture is non-trivial")
  await assert.rejects(client.ask(JSON.stringify({ text: plain }), { harmless: { type: "noul", instructions: "fine" } }))
  assert.equal(previews[0]?.changed, false)
  assert.equal(previews[0]?.unredactable, true)
  assert.match(String(previews[0]?.why), /changed nothing in \d+ words/)
  assert.equal(bodies.length, 0)
  // A short text that carries nothing to redact is not unredactable: "run the tests" is not a payload nobody can vouch for.
  const short = new DecisionClient("k", { url: CLOUD_URL, fetch, egress: { names: true, confirm: async (r) => { previews.push(r); return "send" } } })
  await short.ask(JSON.stringify({ text: "run the tests" }), { harmless: { type: "noul", instructions: "fine" } })
  assert.equal(previews.at(-1)?.unredactable, false)
})

test("a raw client cannot skip the gate, and a loopback server never meets it", async () => {
  const { bodies, fetch } = transport(HARMLESS)
  // The same construction a call site could make by hand: no egress options, a remote URL. It still refuses.
  await assert.rejects(new DecisionClient("k", { url: CLOUD_URL, fetch }).ask("{}", {}), EgressRefused)
  assert.equal(bodies.length, 0)
  // A local server is this machine: it is asked as before, and no preview is involved.
  let previews = 0
  const local = new DecisionClient("local", { url: "http://127.0.0.1:8781/v1/systemone", fetch, egress: { confirm: async () => { previews++; return "send" } } })
  const got = await local.ask(JSON.stringify({ text: "the guards" }), { harmless: { type: "noul", instructions: "fine" } })
  assert.equal(previews, 0, "no preview for a payload that does not leave")
  assert.equal(got.sent, undefined)
  assert.equal(got.egress, undefined)
  assert.equal(bodies.length, 1)
})

test("keep local and cancel send nothing and are in the journal as such", async () => {
  for (const answer of ["keep-local", "cancel"] as const) {
    const { bodies, fetch } = transport(HARMLESS)
    const entries: Entry[] = []
    const config = { ...DEFAULT_BACKENDS, mode: "cloud" as const }
    const askers = makeAskers(config, "k", fetch, () => false, { confirm: async () => answer })
    const d = new Decider(config, askers, (e) => entries.push(e))
    const asked = await d.ask("N5", { task: "Add a flag" }, QUESTIONS, { job: "job-1", session: "ses_w" })
    assert.equal(bodies.length, 0, `${answer}: nothing was sent`)
    assert.equal(asked.backend, "rules", "the caller falls back to its own default")
    const e = entries[0]!
    assert.equal(e.kind, "decision")
    assert.equal(e.mode, "cloud")
    assert.equal(e.backend, "rules")
    assert.equal(e.sent, undefined)
    assert.equal((e.egress as { verdict: string }).verdict, answer)
    assert.match(String(e.error), /kept local/)
    assert.deepEqual(e.state, { task: "Add a flag" }, "the journal keeps the request as it was asked")
  }
})

test("in local mode nothing reaches the gate: no preview, no cloud entry", async () => {
  let previews = 0
  const entries: Entry[] = []
  const { bodies, fetch } = transport(HARMLESS)
  const local = { ...DEFAULT_BACKENDS, mode: "local" as const }
  const askers = makeAskers(local, "a-key", fetch, () => false, { confirm: async () => { previews++; return "send" } })
  const d = new Decider(local, askers, (e) => entries.push(e))
  await d.ask("N5", { task: "Add a flag" }, QUESTIONS, { job: "job-1" })
  assert.equal(previews, 0)
  assert.equal(bodies.length, 1, "the loopback server answered, and no gate was involved")
  assert.equal(entries[0]!.backend, "gliner")
  assert.equal(entries[0]!.sent, undefined)
  assert.equal(entries[0]!.egress, undefined)
})

test("the runner's rules-only decider cannot reach a client at all", () => {
  const d = rulesDecider(() => {})
  for (const node of ["N1", "N5", "N13", "N13.grant", "G0", "git"]) assert.equal(d.backendFor(node), "rules", node)
})

// A2-T6: the gate holds because of where the code is, not because every caller remembered it. Every client is built in
// one file, and no permission site asks a client directly any more.
test("no call site asks a client directly, and every client is built behind the gate", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = "packages"
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".ts")) files.push(path)
    }
  }
  walk(root)
  const builders = files.filter((f) => /new DecisionClient\(/.test(readFileSync(f, "utf8")))
  assert.deepEqual(builders, ["packages/micromanager/src/backends.ts"], "one construction site, which carries the gate")
  const deciders = files.filter((f) => /new Decider\(/.test(readFileSync(f, "utf8"))).sort()
  assert.deepEqual(deciders, ["packages/micromanager/src/backends.ts", "packages/micromanager/src/cli.ts", "packages/micromanager/src/plugin.ts"])
  const plugin_ = readFileSync("packages/micromanager/src/plugin.ts", "utf8")
  assert.doesNotMatch(plugin_, /\bclient\.ask\(/, "a permission site asks the decider, never the client")
})
