// modern-web-guidance as an optional part (creative-tools.ts, web-guidance.ts): installed from its pinned npm tarball
// after a sha512 check, found by its skill version, and registered as a skill that runs the local copy.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"

import { detect, installSteps, PINS, WEB_GUIDANCE_INTEGRITY, WEB_GUIDANCE_SKILL_VERSION, webGuidanceDir, type Home } from "../packages/micromanager/src/creative-tools.ts"
import { adaptGuidance, webGuidanceSkill } from "../packages/micromanager/src/web-guidance.ts"

function machine(t: TestContext): Home {
  const root = mkdtempSync(join(tmpdir(), "wg-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { home: join(root, "home"), data: join(root, "data"), env: {}, sys: join(root, "sys"), dev: join(root, "dev") }
}

const UPSTREAM = `---
name: modern-web-guidance
description: |
  Search tool for modern web development best practices. MANDATORY: Execute FIRST for all HTML/CSS and clientside JS tasks. Do NOT skip — web APIs evolve rapidly and training weights contain obsolete patterns.
---

# Modern Web Guidance

Run \`modern-web-guidance\` directly with \`npx\` using a short query:

\`\`\`sh
npx -y modern-web-guidance@latest search "<query>" --skill-version 2026_11_09-5bcc021b
\`\`\`

## Using npx / pnpx

- Prefer pnpx; request network access before the first execution.

## Guidelines

- Always search first.
`

test("the skill runs the pinned local copy: no npx, no network section, no MANDATORY, and it says it was adapted", () => {
  const dir = "/data/tools/modern-web-guidance"
  const text = adaptGuidance(UPSTREAM, dir)
  assert.ok(text.includes(`node "${dir}/modern-web.mjs" search "<query>"`))
  assert.equal(/npx -y|@latest search|directly with `npx`/.test(text), false)
  assert.equal(text.includes("## Using npx"), false)
  assert.equal(text.includes("request network access"), false)
  assert.equal(text.includes("MANDATORY"), false)
  assert.ok(text.includes("## Guidelines"), "the rest stays")
  assert.match(text, /^---\nname: modern-web-guidance\n[\s\S]*?\n---\n\n> Adapted by omacode from modern-web-guidance 1\.0\.0 \(Google Chrome, Apache-2\.0/)
  assert.match(text, /Baseline widely available/)
})

test("installed from the pinned tarball, checked against its sha512 before anything is unpacked", (t) => {
  const h = machine(t)
  const steps = installSteps("web-guidance", h)
  const lines = steps.map((s) => [s.cmd, ...s.args].join(" "))
  assert.ok(lines.some((l) => l.startsWith(`npm pack modern-web-guidance@${PINS.webGuidance} `) && l.includes("--ignore-scripts")))
  const check = steps.findIndex((s) => s.cmd === "node" && s.args.includes(WEB_GUIDANCE_INTEGRITY))
  const unpack = steps.findIndex((s) => s.cmd === "tar")
  assert.ok(check >= 0 && check < unpack, "the checksum comes before the first unpack")
  assert.ok(lines.some((l) => l.includes("--strip-components=3 package/skills/modern-web-guidance")))
  assert.ok(lines.some((l) => l.includes("package/LICENSE package/THIRD_PARTY_NOTICES")), "its licence comes along")
  assert.equal(lines.some((l) => /chrome-extensions|install\b.*skills/.test(l)), false, "not their installer, not the extensions skill")

  // The check itself: a file whose sha512 is not the pin stops the install.
  const file = join(h.data, "fake.tgz")
  mkdirSync(h.data, { recursive: true })
  writeFileSync(file, "not the tarball")
  const script = steps[check]!.args[1]!
  const r = spawnSync("node", ["-e", script, file, WEB_GUIDANCE_INTEGRITY], { encoding: "utf8" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /checksum mismatch/)
})

test("found by its skill version, and registered only when it is there", async (t) => {
  const h = machine(t)
  const none = async () => ({ code: 1, stdout: "", stderr: "" }) as never
  assert.equal((await detect(none, h)).find((f) => f.name === "web-guidance")?.found, false)
  assert.equal(webGuidanceSkill(h), undefined)
  const dir = webGuidanceDir(h)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "skill-version.txt"), `${WEB_GUIDANCE_SKILL_VERSION}\n`)
  writeFileSync(join(dir, "modern-web.mjs"), "")
  writeFileSync(join(dir, "SKILL.md"), UPSTREAM)
  const found = (await detect(none, h)).find((f) => f.name === "web-guidance")
  assert.deepEqual([found?.found, found?.version, found?.where], [true, PINS.webGuidance, dir])
  const skill = webGuidanceSkill(h)
  assert.equal(skill?.name, "modern-web-guidance")
  assert.match(skill?.description ?? "", /^Search tool for modern web development best practices\. Use it first/)
  writeFileSync(join(dir, "skill-version.txt"), "2027_01_01-other\n")
  assert.equal((await detect(none, h)).find((f) => f.name === "web-guidance")?.version, "unknown (2027_01_01-other)")
})
