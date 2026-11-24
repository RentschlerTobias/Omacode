// No usage reports to the makers of the tools omacode starts (decided by the user, 2026-11-24). Every program omacode
// runs, and every shell an agent opens, gets these variables:
//
//   DO_NOT_TRACK=1              the common opt-out (consoledonottrack.com); HyperFrames and others read it
//   HYPERFRAMES_NO_TELEMETRY=1  HyperFrames' own switch (it reports to PostHog otherwise)
//   DISABLE_TELEMETRY=1         modern-web-guidance (Google Clearcut) and other agent tooling
//
// comfy-cli's tracking is turned off once at install (`comfy tracking disable`, creative-tools.ts); the licence
// manifest (licenses/components.json) says for each tool what it would report and how it is turned off.

export const TELEMETRY_OFF: Readonly<Record<string, string>> = {
  DO_NOT_TRACK: "1",
  HYPERFRAMES_NO_TELEMETRY: "1",
  DISABLE_TELEMETRY: "1",
}

export const TELEMETRY_OFF_NAMES: readonly string[] = Object.keys(TELEMETRY_OFF)

// An environment with the opt-outs set, whatever it said before.
export const withoutTelemetry = <T extends Record<string, string | undefined>>(env: T): T & Record<string, string> => ({ ...env, ...TELEMETRY_OFF })
