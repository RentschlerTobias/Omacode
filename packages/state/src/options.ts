export interface JobOptions {
  readonly auto: boolean // auto-continue: work the todo list without stopping
  readonly parallel: boolean // start every startable todo at once
  readonly review: boolean // a reviewer checks each writer's change before it counts as done
}

export const DEFAULT_OPTIONS: JobOptions = { auto: true, parallel: true, review: false }
