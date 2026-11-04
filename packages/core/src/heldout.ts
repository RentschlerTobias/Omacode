import { dirname, join } from "node:path"
import { journalPath } from "./journal.ts"

// The held-out cases of a contract live outside the project and every worktree, in the state directory that the
// sandbox keeps from every worker.
export function heldOutRoot(): string {
  return join(dirname(journalPath()), "heldout")
}
