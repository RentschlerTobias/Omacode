// Running the slideshow project through the host runner (B3-T3).
//
// None of these functions starts a program itself; they ask the runner (B1-T5), which owns the allowlist, the
// environment, the working directory and the network. Each answer is a result: a refusal, a crash and an unparseable
// envelope all arrive as a value with the output attached, because a job that crashed is still a job to report.
//
// The check and snapshot layers are the HyperFrames runtime's (B2-T1), where the video adapter needs the same envelopes;
// the bounded server start is there too, because a presenter and a preview are the same shape. This file keeps the
// deck's names as aliases and owns the one argv only a deck has. `deck.ts` decides when a run happens; nothing here
// decides that for itself.

import { resolve } from "node:path"

import type { HostRunInput, HostRunner, HostRunResult } from "../adapter.ts"
import {
  HYPERFRAMES_ENV,
  HYPERFRAMES_ENV_NAMES,
  hyperframesCheck,
  hyperframesServe,
  hyperframesSnapshot,
  type HyperframesReport,
  type HyperframesServerStart,
  type HyperframesSnapshot,
  type HyperframesSnapshotOptions,
} from "./hyperframes.ts"

// The deck's names for the runtime's readers and declarations. A deck check and a video check read the same envelope;
// only the adapter's mapping differs, so the run lives in `hyperframes.ts` and these are the names the deck published.
export { recordOf } from "./hyperframes.ts"
export const DECK_ENV_NAMES = HYPERFRAMES_ENV_NAMES
export type DeckCheck = HyperframesReport
export type DeckSnapshot = HyperframesSnapshot
export type DeckSnapshotOptions = HyperframesSnapshotOptions
export const deckCheck = hyperframesCheck
export const deckSnapshot = hyperframesSnapshot

export type DeckPresent = HyperframesServerStart

// `hyperframes present <job> --no-open --port <port>`, returned once the port answers. The run itself is not awaited:
// the runner is one-run-at-a-time by design, so a presented deck occupies it until the caller calls `run.cancel()`, and
// a function that awaited the server would never return. That is the contract the adapter relies on — the presenter is
// the job's foreground, and cancelling it is how the job ends.
//
// The job is presented with the network declaration its runner was built with. A presenter is a local HTTP server that
// the user's browser has to reach, so a runner with the network unshared can start it but nothing outside its namespace
// can open the page; the caller that wants to look at a deck builds that runner with the network shared.
export function deckPresent(run: HostRunner, jobDir: string, port: number): Promise<DeckPresent> {
  // The presenter's server listens inside the child's namespace, so it is reachable from the user's browser only when
  // the run asks for the host network. Every other call this adapter makes leaves it out and stays wrapped.
  const input: HostRunInput = {
    exe: "hyperframes",
    args: ["present", resolve(jobDir), "--no-open", "--port", String(port)],
    network: true,
  }
  return hyperframesServe(run, () => run.run(input), port, "hyperframes present")
}

// One build as one entry in the deck's HyperFrames history, so a build can be undone or restored like a Studio edit
// (`hyperframes history`). Under the runner HOME is `<job>/.home`, so the history lives in the deck's own folder
// (`.home/.cache/hyperframes/history`), and the Studio, which also runs under the runner, reads the same one. `begin`
// needs a page to exist, so the first build records its starting point after it wrote, with an empty turn.
export async function deckHistory(run: HostRunner, jobDir: string, args: readonly string[]): Promise<HostRunResult> {
  return run.run({ exe: "hyperframes", args: ["history", ...args, "--dir", resolve(jobDir)], env: { ...HYPERFRAMES_ENV } })
}

// `hyperframes preview <job> --no-open --port <port> --foreground`: HyperFrames Studio on the deck, where the user can
// look at it on a timeline and change it by hand. Same contract as the presenter: returned once the port answers, held
// until `run.cancel()`. `--foreground` keeps it attached: the runner's child has no terminal, and without the flag the
// CLI would detach a background server the runner could not stop. A page changed here is protected from the next build
// by the writer's stamp (DECK_STAMP in deck-project.ts).
export function deckStudio(run: HostRunner, jobDir: string, port: number): Promise<DeckPresent> {
  const input: HostRunInput = {
    exe: "hyperframes",
    args: ["preview", resolve(jobDir), "--no-open", "--port", String(port), "--foreground"],
    network: true,
  }
  return hyperframesServe(run, () => run.run(input), port, "hyperframes preview")
}
