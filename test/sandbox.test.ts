import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { heldOutRoot } from "../src/contract.ts"
import { isChildShell, isDelegated } from "../src/shell/decide.ts"
import { cleanEnv, looksSecret, neverHanded, REGISTRIES, rulesFor, startSandbox, tempDirFor, withTemp, WorkerShells } from "../src/sandbox.ts"

test("a worker's environment is an allowlist; the never list beats any grant", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "de_DE.UTF-8", LC_ALL: "C", NODE_OPTIONS: "--x", UV_CACHE_DIR: "/c",
    OPENAI_API_KEY: "sk-1", GITHUB_TOKEN: "ghp", SOMETHING_NEW: "x", DATABASE_URL: "postgres://u:p@h/db",
    SSH_AUTH_SOCK: "/run/a", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", HYPRLAND_INSTANCE_SIGNATURE: "h",
    CLAUDE_CODE_MESSAGING_TOKEN: "t", JEV_API_KEY: "j",
  }
  assert.deepEqual(Object.keys(cleanEnv(env)).sort(), ["CI", "HOME", "LANG", "LC_ALL", "NODE_OPTIONS", "PATH", "UV_CACHE_DIR"])
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

// A real run through bubblewrap where the machine has it (skipped elsewhere): the spike's checks as a test.
test("the sandbox keeps a writer in its worktree, away from the user's keys and off the network", async (t) => {
  const sandbox = await startSandbox()
  if (!sandbox.available) return t.skip(`no sandbox here: ${sandbox.reason}`)
  // The tree the writer works in. It lies beside the workers' temp root (which the sandbox denies), not under it:
  // the home directory is read-only in a worker's sandbox, and the temp root is the one place every worker shares.
  const root = mkdtempSync(join(tmpdir(), ".mm-sandbox-test-"))
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
      return t.skip(`the sandbox cannot run here: ${String(err).trim().split("\n").pop()}`)
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
