// The questions a context plugin asks a decider, and the answers it gets back. The shape mirrors the host's
// Jev types so a real decider can be passed in, but the package does not import the orchestrator.
export type AskQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string }

export type AskAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }

export interface Asker {
  ask(
    id: string,
    state: Record<string, unknown>,
    questions: Record<string, AskQuestion>,
    options?: { job?: string },
  ): Promise<{ decision: { answers: Record<string, AskAnswer> } }>
}

export const NOUL_FLOOR = 0.5
