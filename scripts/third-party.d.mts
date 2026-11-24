// Types for scripts/third-party.mjs, for the test that checks the committed manifest against it.

export interface Row {
  readonly name: string
  readonly version: string
  readonly spdx: string
}

export interface Manifest {
  readonly about: string
  readonly components: readonly Record<string, string>[]
  readonly npm: readonly Row[]
  readonly python: readonly Row[]
}

export function npmPackages(lock: unknown): Row[]
export function pythonPackages(venv: string): Row[] | undefined
export function build(input: { components: { components: readonly Record<string, string>[] }; lock: unknown; python?: readonly Row[] }): Manifest
export function markdown(manifest: Manifest): string
