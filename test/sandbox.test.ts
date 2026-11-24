import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { heldOutRoot } from "../packages/micromanager/src/contract.ts"
import { gateFor } from "../packages/micromanager/src/gatebox.ts"
import { exec as realExec, runGate } from "../packages/micromanager/src/integration.ts"
import { isChildShell, isDelegated } from "../packages/micromanager/src/shell/decide.ts"
import { cleanEnv, looksSecret, neverHanded, planRules, REGISTRIES, rulesFor, startSandbox, tempDirFor, withTemp, WorkerShells } from "../packages/micromanager/src/sandbox.ts"
import { planRoot } from "../packages/micromanager/src/writeguard.ts"
import { tempDir } from "./harness.ts"

test("a worker's environment is an allowlist; the never list beats any grant", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "de_DE.UTF-8", LC_ALL: "C", NODE_OPTIONS: "--x", UV_CACHE_DIR: "/c",
    OPENAI_API_KEY: "sk-1", GITHUB_TOKEN: "ghp", SOMETHING_NEW: "x", DATABASE_URL: "postgres://u:p@h/db",
    SSH_AUTH_SOCK: "/run/a", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", HYPRLAND_INSTANCE_SIGNATURE: "h",
    CLAUDE_CODE_MESSAGING_TOKEN: "t", JEV_API_KEY: "j",
  }
  assert.deepEqual(Object.keys(cleanEnv(env)).sort(), ["CI", "DISABLE_TELEMETRY", "DO_NOT_TRACK", "HOME", "HYPERFRAMES_NO_TELEMETRY", "LANG", "LC_ALL", "NODE_OPTIONS", "PATH", "UV_CACHE_DIR"])
  const granted = cleanEnv(env, ["DATABASE_URL", "SSH_AUTH_SOCK", "DBUS_*"])
  assert.equal(granted.DATABASE_URL, "postgres://u:p@h/db", "a grant adds a name")
  assert.equal(granted.SSH_AUTH_SOCK, undefined, "the never list wins")
  assert.equal(granted.DBUS_SESSION_BUS_ADDRESS, undefined)
  assert.equal(granted.CI, "1")
  assert.ok(neverHanded("HYPRLAND_INSTANCE_SIGNATURE") && neverHanded("HERDR_SOCKET_PATH") && !neverHanded("NODE_ENV"))
  assert.ok(looksSecret("GITHUB_TOKEN") && looksSecret("STRIPE_SECRET") && looksSecret("DB_PASSWORD") && looksSecret("OPENAI_API_KEY"))
  assert.ok(looksSecret("DATABASE_URL", "postgres://u:p@h/db"), "a URL with a password in it")
  assert.ok(!looksSecret("NODE_ENV", "test") && !looksSecret("RUST_LOG") && !looksSecret("DATABASE_URL", "sqlite:///tmp/x.db"))
})

test("a writer writes its worktree only, a reader nothing; keys and env files stay unreadable; registries are open", () => {
  const writer = rulesFor({ role: "code", writer: true, dir: "/p/.micromanager/worktrees/job--T1/sub", worktree: "/p/.micromanager/worktrees/job--T1", domains: ["api.example.com"] })
  assert.deepEqual(writer.filesystem.allowWrite, ["/p/.micromanager/worktrees/job--T1"])
  assert.ok(!writer.filesystem.allowWrite.includes("/tmp"), "never /tmp as a whole")
  assert.ok(writer.filesystem.denyRead.includes("~/.ssh") && writer.filesystem.denyRead.includes("~/.config/opencode"))
  assert.ok(writer.filesystem.denyRead.includes("/p/.micromanager/worktrees/job--T1/sub/**/.env"))
  assert.deepEqual(writer.filesystem.allowRead, ["/p/.micromanager/worktrees/job--T1/sub/**/.env.example"])
  assert.ok(REGISTRIES.every((d) => writer.network.allowedDomains.includes(d)) && writer.network.allowedDomains.includes("api.example.com"))
  assert.deepEqual(rulesFor({ role: "explore", writer: false, dir: "/p" }).filesystem.allowWrite, [])
  assert.ok(writer.filesystem.denyRead.includes(heldOutRoot()), "the held-out cases of contracts, wherever the state directory is")
  // A writer's frozen tests: inside its own worktree, and still not writable from its shell.
  assert.deepEqual(writer.filesystem.denyWrite, [])
  assert.deepEqual(rulesFor({ role: "code", writer: true, dir: "/w", worktree: "/w", frozen: ["/w/test/a.test.js"] }).filesystem.denyWrite, ["/w/test/a.test.js"])
})

test("a plan job's writer writes the plan area and its temp directory only, never the project", () => {
  const project = "/home/u/project"
  const plan = "/home/u/.state/plan/job-1"
  const dir = join(plan, "worktrees", "T1")
  const rules = planRules({ role: "investigator", writer: true, dir, worktree: plan })
  assert.deepEqual(rules.filesystem.allowWrite, [plan], "the plan root is the one writable place")
  assert.ok(!rules.filesystem.allowWrite.some((p) => p === project || p.startsWith(`${project}/`)), "the project is not writable")
  // The plan worker's own temp directory is writable too; nothing else is.
  const temp = tempDirFor("plan-rules-test")
  const withTempDir = planRules({ role: "investigator", writer: true, dir, worktree: plan, temp })
  assert.deepEqual(withTempDir.filesystem.allowWrite, [plan, temp])
})

// A real run through bubblewrap where the machine has it (skipped elsewhere): the spike's checks as a test.
test("the sandbox keeps a writer in its worktree, away from the user's keys and off the network", async (t) => {
  const sandbox = await startSandbox()
  if (!sandbox.available) return t.skip(`no sandbox here: ${sandbox.reason}`)
  // The tree the writer works in. It lies outside the workers' temp root (which the sandbox denies), and the helper
  // keeps it writable where a worker's /tmp is not: the home directory is read-only in a worker's sandbox.
  const root = tempDir(".mm-sandbox-test-")
  try {
    const a = join(root, "A")
    const b = join(root, "B")
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(a, ".env"), "TOKEN=x\n")
    writeFileSync(join(a, "frozen.test.js"), "ok\n")
    const run = async (dir: string, command: string) => {
      const wrapped = await sandbox.wrap(command, rulesFor({ role: "code", writer: true, dir, worktree: dir, domains: [], frozen: [join(a, "frozen.test.js")] }))
      try {
        return execFileSync("bash", ["-c", wrapped], { cwd: dir, env: cleanEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
      } catch (err) {
        return `failed: ${String((err as { stderr?: string }).stderr ?? err).trim().split("\n").pop()}`
      }
    }
    // The sandbox needs a unix socket for its proxy, and a worker's sandbox has no user namespaces to give it: a
    // host that cannot run the sandbox at all skips the rest of the test rather than failing it.
    try {
      await sandbox.wrap("true", rulesFor({ role: "code", writer: true, dir: a, worktree: a, domains: [], frozen: [] }))
    } catch (err) {
      return t.skip(`the sandbox runtime cannot open its socket here: ${String(err).trim().split("\n").pop()}`)
    }
    assert.equal(await run(a, "echo ok > own.txt && cat own.txt"), "ok")
    assert.match(await run(b, `echo x > ${join(a, "theirs.txt")}`), /failed: .*(Read-only|Permission denied)/)
    assert.equal(existsSync(join(a, "theirs.txt")), false)
    assert.match(await run(a, "cat .env"), /failed/)
    assert.match(await run(a, "curl -sS -m 5 https://example.com -o /dev/null && echo reached"), /failed/)
    assert.equal(readFileSync(join(a, "own.txt"), "utf8"), "ok\n")
    // A frozen test inside the writer's own worktree: readable and runnable, not writable from its shell either.
    assert.equal(await run(a, "cat frozen.test.js"), "ok")
    assert.match(await run(a, "sed -i s/ok/no/ frozen.test.js"), /failed/)
    assert.match(await run(a, "echo no > frozen.test.js"), /failed/)
    assert.equal(readFileSync(join(a, "frozen.test.js"), "utf8"), "ok\n")
    // Each worker has its own temp directory as TMPDIR, which the others can neither see nor write (2026-10-27:
    // sandbox-runtime's TMPDIR=/tmp/claude did not exist, so mktemp failed in every worker).
    const tempA = tempDirFor(`test\0${a}`)
    const tempB = tempDirFor(`test\0${b}`)
    writeFileSync(join(tempB, "note"), "theirs\n")
    const inTemp = async (command: string) => {
      const wrapped = await sandbox.wrap(withTemp(command, tempA), rulesFor({ role: "explore", writer: false, dir: a, temp: tempA }))
      try {
        return execFileSync("bash", ["-c", wrapped], { cwd: a, env: cleanEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
      } catch (err) {
        return `failed: ${String((err as { stderr?: string }).stderr ?? err).trim().split("\n").pop()}`
      }
    }
    assert.equal(await inTemp('f=$(mktemp) && echo hi > "$f" && cat "$f" && test "$TMPDIR" = ' + `'${tempA}'`), "hi")
    assert.equal(await inTemp('mkdir -p "$XDG_CACHE_HOME/quarto" "$npm_config_cache/x" && echo cache > "$XDG_CACHE_HOME/quarto/ok" && cat "$XDG_CACHE_HOME/quarto/ok"'), "cache")
    assert.match(await inTemp(`cat ${join(tempB, "note")}`), /failed/)
    assert.match(await inTemp(`echo x > ${join(tempB, "w")}`), /failed/)
    assert.match(await inTemp("echo x > own.txt"), /failed/, "a reader still writes nothing but its temp directory")
    execFileSync("rm", ["-rf", tempA, tempB])
  } finally {
    execFileSync("rm", ["-rf", root])
    await sandbox.stop()
  }
})

// A1-T9/T7: the plan worktree lies *inside* the project (the state directory is a project directory), so the plan rules
// cannot lean on "the project is somewhere else": only the named plan root is writable, and every other path of the
// project stays read-only. Interpreters are the point of the test: `node -e` and `sed -i` name no path a command parser
// could see, so only the sandbox can refuse the write.
test("a plan worktree cannot write the project, not even through node -e or sed -i", async (t) => {
  const sandbox = await startSandbox()
  if (!sandbox.available) return t.skip(`no sandbox here: ${sandbox.reason}`)
  const root = tempDir(".mm-plan-write-test-")
  const temp = tempDirFor(`test\0plan-write`)
  try {
    const project = join(root, "project")
    mkdirSync(project)
    writeFileSync(join(project, "README.md"), "the project's readme\n")
    const plan = planRoot(project)
    const dir = join(plan, "job-1", "worktrees", "T1")
    mkdirSync(dir, { recursive: true })
    const rules = planRules({ role: "investigator", writer: true, dir, worktree: plan, domains: [], frozen: [], temp })
    const run = async (command: string) => {
      const wrapped = await sandbox.wrap(withTemp(command, temp), rules)
      try {
        return execFileSync("bash", ["-c", wrapped], { cwd: dir, env: cleanEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
      } catch (err) {
        return `failed: ${String((err as { stderr?: string }).stderr ?? err).trim().split("\n").pop()}`
      }
    }
    // The sandbox needs a unix socket for its proxy, as above: a host that cannot open it skips rather than fails.
    try {
      await sandbox.wrap("true", rules)
    } catch (err) {
      return t.skip(`the sandbox runtime cannot open its socket here: ${String(err).trim().split("\n").pop()}`)
    }
    // The plan worktree is writable and the project is readable: the barrier is about writing, not reading.
    assert.equal(await run("echo ok > draft.md && cat draft.md"), "ok")
    assert.equal(await run(`cat ${join(project, "README.md")}`), "the project's readme")
    // An interpreter writing inside the plan worktree works, so the two refusals below are the sandbox's writing rule
    // and not a broken runtime.
    assert.equal(await run(`${process.execPath} -e "require('fs').writeFileSync('${join(dir, "from-node.md")}','inside')"`), "")
    assert.equal(readFileSync(join(dir, "from-node.md"), "utf8"), "inside")

    assert.match(await run(`${process.execPath} -e "require('fs').writeFileSync('${join(project, "pwned")}','x')"`), /failed/)
    assert.match(await run(`sed -i s/readme/pwned/ ${join(project, "README.md")}`), /failed/)
    assert.equal(existsSync(join(project, "pwned")), false, "no file appeared in the project")
    assert.equal(readFileSync(join(project, "README.md"), "utf8"), "the project's readme\n", "the project's file is unchanged")
  } finally {
    execFileSync("rm", ["-rf", root])
    execFileSync("rm", ["-rf", temp])
    await sandbox.stop()
  }
})

test("a hostile check cannot touch the project at gate time", async (t) => {
  const sandbox = await startSandbox()
  if (!sandbox.available) return t.skip(`no sandbox here: ${sandbox.reason}`)
  const root = tempDir(".mm-gate-hostile-")
  try {
    const project = join(root, "project")
    const worktree = join(root, "worktrees", "job--T1")
    mkdirSync(project)
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(project, "README.md"), "keep\n")
    const gate = await gateFor(
      { box: async () => sandbox, grants: () => ({ domains: [], env: [] }) },
      { project, jobId: "job-test", plan: false, writer: true, role: "code", worktree, dir: worktree },
    )
    // The sandbox needs a unix socket for its proxy, as above: a host that cannot open it skips rather than fails.
    try {
      await gate.wrap("true")
    } catch (err) {
      return t.skip(`the sandbox runtime cannot open its socket here: ${String(err).trim().split("\n").pop()}`)
    }
    const [result] = await runGate(worktree, [`echo pwned > ${project}/pwned.txt; rm -rf ${project}/README.md`], realExec, 30_000, worktree, {}, gate)
    assert.ok(result)
    assert.equal(result.skipped, undefined, "the check ran; the skip is for a machine without a sandbox")
    assert.equal(result.passed, false, "a hostile check fails instead of touching the project")
    assert.equal(existsSync(join(project, "pwned.txt")), false, "nothing was written beside the worktree")
    assert.equal(readFileSync(join(project, "README.md"), "utf8"), "keep\n", "nothing was deleted from the project")
  } finally {
    execFileSync("rm", ["-rf", root])
    await sandbox.stop()
  }
})

test("only a shell a worker asked for is wrapped, once per call", () => {
  const shells = new WorkerShells()
  assert.equal(shells.take("npm test"), false, "a shell no worker asked for is left alone")
  shells.expect("npm test")
  shells.expect("npm test")
  assert.equal(shells.take("npm test"), true)
  assert.equal(shells.take("npm test"), true)
  assert.equal(shells.take("npm test"), false, "each call is taken once")
})

test("the sandbox wraps a child shell of any plugin and never the user's own shell", () => {
  // The decision the shell plugin makes, without a host: a delegated child (a session with a parent) is wrapped,
  // whatever plugin started it; a root session (the user's own interactive session) is left alone.
  const child = { tool: "shell", sessionID: "ses_child" }
  const root = { tool: "shell", sessionID: "ses_root" }

  // A child of any plugin: the session record says it was delegated, and the plugin that started it is none of
  // the sandbox's business.
  assert.equal(isChildShell(child, { parentID: "ses_other_plugin" }), true, "a subagent of any plugin is wrapped")
  assert.equal(isChildShell(child, { parentID: "ses_micromanager" }), true, "a subagent of the micromanager is wrapped")

  // The user's own interactive shell: a root session has no parent, so it is never wrapped.
  assert.equal(isChildShell(root, {}), false, "the user's own shell is not wrapped")
  assert.equal(isChildShell(root, { parentID: undefined }), false, "the user's own shell is not wrapped")

  // A session the plugin knows as a worker is a worker even without a parent id.
  assert.equal(isChildShell(child, { worker: true }), true, "a known worker is wrapped")

  // Only the shell tool is wrapped.
  assert.equal(isChildShell({ tool: "bash", sessionID: "ses_child" }, { parentID: "ses_root" }), false, "another tool is not a shell")

  assert.equal(isDelegated({ parentID: "ses_root" }), true)
  assert.equal(isDelegated({}), false)
})

test("the shell remembers which session asked for a command", () => {
  const shells = new WorkerShells()
  assert.equal(shells.sessionOf("npm test"), undefined, "a command nobody asked for has no session")
  shells.expect("npm test", "ses_worker")
  assert.equal(shells.sessionOf("npm test"), "ses_worker", "the session that asked is remembered")
  assert.equal(shells.take("npm test"), true)
  assert.equal(shells.sessionOf("npm test"), undefined, "the session goes with the command")
})
