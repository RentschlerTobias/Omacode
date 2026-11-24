// modern-web-guidance as a skill agents can use (Google Chrome, Apache-2.0; installed by creative-tools.ts at its pin).
// The upstream skill tells an agent to run `npx -y modern-web-guidance@latest …` for every web task: that fetches and
// runs whatever version is newest, over the network, every time. omacode installs one pinned, checksum-checked copy
// and registers an adapted skill instead (Apache-2.0 §4: the change is stated in the skill itself):
//
// - every `npx -y modern-web-guidance@latest` becomes `node "<copy>/modern-web.mjs"`: local, pinned, offline;
// - the section on npx, pnpx and asking for network access is dropped (none is needed);
// - "MANDATORY … Do NOT skip" becomes a plain instruction, and a note asks for features that are Baseline widely
//   available unless the user targets newer browsers (each guide states its support and a fallback).
//
// search and retrieve report nothing to Google; the commands that would (install, update, list, legacy-scan) run with
// DISABLE_TELEMETRY=1 in every agent shell (core/telemetry.ts).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { home, PINS, webGuidanceDir, type Home } from "./creative-tools.ts"
import type { SkillFile } from "./skills.ts"

export const WEB_GUIDANCE_SKILL = "modern-web-guidance"

const NOTE = (dir: string) => `> Adapted by omacode from modern-web-guidance ${PINS.webGuidance} (Google Chrome, Apache-2.0; licence in ${dir}/LICENSE):
> the commands run the pinned local copy instead of \`npx … @latest\`, which needs no network; the npx section is left
> out. Prefer features that are Baseline widely available unless the user targets newer browsers: every guide states
> its browser support and gives a fallback.`

export function adaptGuidance(text: string, dir: string): string {
  const cli = `node "${join(dir, "modern-web.mjs")}"`
  let out = text
    .replace(/npx -y modern-web-guidance@latest/g, cli)
    .replace(/npx modern-web-guidance@latest/g, cli)
    .replace(/Run `modern-web-guidance` directly with `npx`/g, "Run the local `modern-web-guidance` (the command below)")
    .replace(/MANDATORY: Execute FIRST for all HTML\/CSS and clientside JS tasks\. Do NOT skip — web APIs evolve rapidly and training weights contain obsolete patterns\./, "Use it first for HTML/CSS and client-side JS work: web APIs evolve rapidly and training data contains obsolete patterns.")
  // The section about running it through npx/pnpx and asking for network access: not needed for the local copy.
  out = out.replace(/\n## Using npx \/ pnpx\n[\s\S]*?(?=\n## )/, "\n")
  // The note goes right after the front matter.
  const end = out.indexOf("\n---", 3)
  return end > 0 ? `${out.slice(0, end + 4)}\n\n${NOTE(dir)}\n${out.slice(end + 4)}` : `${NOTE(dir)}\n\n${out}`
}

// The skill when the copy is installed, else nothing (it is an optional part).
export function webGuidanceSkill(h: Home = home()): SkillFile | undefined {
  const dir = webGuidanceDir(h)
  const path = join(dir, "SKILL.md")
  if (!existsSync(path) || !existsSync(join(dir, "modern-web.mjs"))) return undefined
  const content = adaptGuidance(readFileSync(path, "utf8"), dir)
  const description = /^description:\s*\|?\s*\n?\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "modern web development best practices, searched offline"
  return { name: WEB_GUIDANCE_SKILL, description, path, content }
}
