// Taking memory kept under old keys into a project (memory-adopt in the CLI). Until 2026-11-21 a project's entries
// were keyed by a hash of its folder's path, so every rename, move or copy started an empty memory and left the old
// entries under a key nothing asks for any more; worker sessions kept theirs under their worktree's path. A hash cannot
// be traced back to its folder, so this only proposes: keys with the project's folder name, and keys of worktrees of
// the project's own jobs. The user decides, the command moves.

import { existsSync, readdirSync } from "node:fs"

import { statePath } from "@omacode/core/paths"
import { projectId } from "@omacode/core/project"

import type { MemoryStore } from "./store.ts"

export interface Candidate {
  readonly slug: string
  readonly entries: number
  readonly updated: string
  readonly why: "same folder name" | "worktree of this project's job"
  readonly sample: readonly string[]
}

// The name part of a slug: everything before its six-digit hash.
export function slugName(slug: string): string {
  return slug.replace(/-[0-9a-f]{6}$/, "")
}

// The jobs the project has had, from its state directory: a worktree session's key starts with one of them.
function jobIds(project: string): string[] {
  const dir = statePath(project, "jobs")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length))
}

export function adoptCandidates(store: MemoryStore, project: string): { id: string; candidates: Candidate[] } {
  const id = projectId(project)
  const name = slugName(id)
  const jobs = jobIds(project)
  const candidates: Candidate[] = []
  for (const p of store.projects()) {
    if (p.project === id) continue
    const why = slugName(p.project) === name
      ? "same folder name"
      : jobs.some((job) => p.project === job || p.project.startsWith(`${job}-`))
        ? "worktree of this project's job"
        : undefined
    if (!why) continue
    const sample = store.list({ project: p.project }).filter((e) => e.scope === "project").slice(-2).map((e) => e.text.split("\n")[0]!.slice(0, 100))
    candidates.push({ slug: p.project, entries: p.entries, updated: p.updated, why, sample })
  }
  return { id, candidates: candidates.sort((a, b) => b.updated.localeCompare(a.updated)) }
}

// Moves the entries of the given keys into the project, which gets its id file now, so the next rename keeps them.
export function adopt(store: MemoryStore, project: string, slugs: readonly string[]): { id: string; moved: number } {
  const id = projectId(project, { create: true })
  return { id, moved: store.reassign(slugs, id) }
}
