// The artifact package's entry point: the contracts (B1-T1), the checks registry that gates them (B1-T2), the
// provenance an artifact travels with (B1-T3), the adapter interface (B1-T4) that turns a spec into files, the host
// runner (B1-T5) that executes the adapter's declared programs and the quality gate (B1-T7) that decides what is worth
// shipping. Later tasks add their own module, so this file re-exports rather than defines — an empty placeholder here
// would suggest the package has less to say than it does.
//
// The runner's types are named rather than starred: adapter.ts already exports `HostRunInput`, `HostRunResult` and
// `HostRunner`, and a second star of the same names would be an ambiguity the compiler has to be told about.
export * from "./spec.ts"
export * from "./checks.ts"
export * from "./provenance.ts"
export * from "./adapter.ts"
export * from "./quality.ts"
export * from "./paths.ts"
export * from "./png.ts"
export * from "./storyboard.ts"
export * from "./qa.ts"
export * from "./comfyui.ts"
export { createHostRunner, hostRunnerFor, resolveHostRun } from "./runner.ts"
export type { HostRunCheck, HostRunReady, HostRunRefused, HostRunnerOptions } from "./runner.ts"
export * from "./adapters/deck.ts"
export * from "./adapters/video.ts"
export * from "./adapters/image.ts"
