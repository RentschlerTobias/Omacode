import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { stateDir, statePath } from "../packages/core/src/paths.ts"
import { gitForm, readForm } from "../packages/micromanager/src/forms.ts"
import { copyForPlan, gitState, initRepo, MAX_FILE_BYTES, surveyFolder } from "../packages/micromanager/src/nogit.ts"
import { tempDir } from "./harness.ts"

const folder = () => tempDir("mm-nogit-")
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args]).toString().trim()

test("a folder is a repository, one without a commit, or none", async () => {
  const dir = folder()
  assert.equal(await gitState(dir), "no-repo")
  git(dir, "init", "-q")
  assert.equal(await gitState(dir), "no-commit")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
  assert.equal(await gitState(dir), "repo")
})

test("the survey leaves secrets, generated folders and huge files out of the first commit, and init commits the rest", async () => {
  const dir = folder()
  writeFileSync(join(dir, "main.py"), "print('hi')\n")
  writeFileSync(join(dir, ".env"), "TOKEN=x\n")
  writeFileSync(join(dir, "server.key"), "k\n")
  mkdirSync(join(dir, "node_modules", "a"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "a", "i.js"), "x\n")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "util.py"), "x = 1\n")
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1))
  const survey = surveyFolder(dir)
  assert.deepEqual([...survey.excluded].sort(), [".env", "big.bin", "node_modules/", "server.key"])
  assert.equal(survey.files, 2)
  assert.equal(survey.extensions.py, 2)

  const r = await initRepo(dir, survey.excluded)
  assert.ok(r.ok, r.text)
  assert.equal(await gitState(dir), "repo")
  assert.deepEqual(git(dir, "ls-files").split("\n").sort(), [".gitignore", "main.py", "src/util.py"])
  const ignore = readFileSync(join(dir, ".gitignore"), "utf8")
  assert.match(ignore, /^\.micromanager\/\*$/m)
  assert.match(ignore, /^!\.micromanager\/backlog\/$/m)
  assert.match(ignore, /^\/\.env$/m)
})

test("initRepo's first commit carries the user's identity and the plain subject", async () => {
  const dir = folder()
  const config = join(folder(), "gitconfig")
  writeFileSync(config, "[user]\n\tname = N\n\temail = n@n\n")
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const
  const saved = keys.map((key) => [key, process.env[key]] as const)
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  for (const key of keys.slice(2)) delete process.env[key]
  try {
    writeFileSync(join(dir, "main.py"), "print('hi')\n")
    const r = await initRepo(dir, surveyFolder(dir).excluded)
    assert.ok(r.ok, r.text)
    assert.equal(git(dir, "log", "-1", "--format=%an <%ae>"), "N <n@n>")
    assert.equal(git(dir, "log", "-1", "--format=%s"), "Initial commit")
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("the no-git form puts the recommended way first and reads the answer", () => {
  const form = gitForm("/home/u/notes", 12, "40 KB", "none", [".env"])
  assert.match(form[0]!.options[0]!.label, /^Without isolation \(Recommended\)$/)
  assert.match(form[0]!.options[1]!.description, /left out: \.env/)
  assert.deepEqual(readForm(form, [["Without isolation (Recommended)"]]), { kind: "git", decision: "none" })
  assert.deepEqual(readForm(form, [["Create a git repository"]]), { kind: "git", decision: "init" })
})

// Every entry, not just the top level: a link deep in the copy would be followed by whatever reads the plan later.
function linksIn(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) out.push(path)
    else if (st.isDirectory()) linksIn(path, out)
  }
  return out
}

test("a plan copy leaves secrets, generated folders and huge files out (as .env.example too: SECRET matches it), never follows a symlink, and does not copy the state directory it writes into", () => {
  const project = tempDir("mm-plan-copy-")
  const outside = tempDir("mm-plan-outside-")
  try {
    writeFileSync(join(project, "normal.txt"), "hello\n")
    writeFileSync(join(project, ".env"), "TOKEN=x\n")
    writeFileSync(join(project, ".env.example"), "TOKEN=\n")
    mkdirSync(join(project, "node_modules"))
    writeFileSync(join(project, "node_modules", "x.js"), "x\n")
    writeFileSync(join(project, "id_rsa"), "k\n")
    writeFileSync(join(project, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1))
    writeFileSync(join(outside, "leak.txt"), "outside\n")
    symlinkSync(outside, join(project, "outside-link"))
    symlinkSync(".", join(project, "loop")) // a link to the project itself, which a following copy would chase forever

    const dest = statePath(project, "plan", "j", "worktrees", "t")
    const copy = copyForPlan(project, dest) // returned: a followed "loop" would not have

    assert.equal(readFileSync(join(dest, "normal.txt"), "utf8"), "hello\n")
    for (const name of [".env", ".env.example", "id_rsa", "big.bin", "outside-link", "loop", "node_modules"]) {
      assert.equal(existsSync(join(dest, name)), false, `${name} is not copied`)
    }
    assert.equal(existsSync(join(dest, "leak.txt")), false, "a symlink out of the project carries nothing in")
    assert.deepEqual(linksIn(dest), [], "the copy holds no symlink")
    assert.equal(existsSync(join(dest, "plan")), false, "the state directory is not copied into itself")
    assert.deepEqual(readdirSync(dest), ["normal.txt"])
    assert.equal(copy.files, 1)
    assert.equal(copy.bytes, 6)
    assert.deepEqual(
      [...copy.excluded].sort(),
      [".env", ".env.example", "big.bin", "id_rsa", "loop", "node_modules/", "outside-link", `${stateDir(project)}/`].sort(),
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
