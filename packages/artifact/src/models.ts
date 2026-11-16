// The model registry (B5-T4, D18): which checkpoints this package may load, under which licence, in which territory,
// and for what — resolved by the hash of the weights, never by the name a spec declares. A ComfyUI workflow can name any
// file on the server's disk, so "SDXL base" in an images.json proves nothing about the bytes a graph will load. The
// hash is the fact; the name travels beside it as a label for the reader.
//
// Three answers, and no fourth: a hash that is known and permitted proceeds; a hash that is on the blocklist is refused
// and the refusal names the model and the reason; a hash nobody has recorded is refused as well, with the offer to
// register it together with its licence and territory. There is no silent allowance, and a checkpoint with no hash at
// all is the unknown case rather than an exception to it.
//
// The table below is code, because a table a spec could edit would be a licence policy chosen by the job it governs.
// `registerModel` is the one way to add to it, and what it writes is a separate file under the user's state directory:
// visible, reversible, and read back on every adapter run. A registered entry is consulted first, so the user's own
// record wins over the code table; that is the point of asking, and the file can be deleted to undo it.
//
// Licences are SPDX identifiers where an SPDX identifier exists ("Apache-2.0"), and `LicenseRef-…` where none does — a
// licence that has no SPDX entry is still recorded by the name its own text uses, never rounded to "Apache-2.0" because
// it looks open. Each entry says how it was verified, and the two ways are the only two this file accepts: a hash is
// listed (the published sha256 of the weights, or one computed from a file on this machine), or the entry states in
// words that it cannot be verified here. CogVideoX is the case the roadmap names: the 2B weights are Apache-2.0 and the
// 5B weights are not, and the two are separate entries rather than one averaged one.
//
// Nothing here talks to a network. The hashes and licence tags in the table were read from Hugging Face's public model
// metadata while this round was written, and the date is in each `verified` line; re-checking them is a reading of the
// same API, not a runtime dependency. Where the local machine could answer — the GGUF installed under ~/Models — the
// hash was computed from the file here and matched against the publisher's, and the entry says so.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { canonicalJson } from "./spec.ts"

// The territories a licence is checked against. The list is short on purpose: D3 names the three that matter to this
// project (the EU, the UK, South Korea) and the two a licence usually speaks about in this field. "world" means the
// licence grants use everywhere it was read, so any of the others is included in it. Adding a territory is a code change
// for the same reason the table is code: a job must not be able to declare itself covered.
export const TERRITORIES = ["EU", "UK", "South Korea", "US", "world"] as const
export type Territory = (typeof TERRITORIES)[number]

// The user is in Germany and the project is not commercial (D2), so the EU is what an unstated question means.
export const DEFAULT_TERRITORY: Territory = "EU"

const SHA256 = /^[0-9a-f]{64}$/

// What the table records about one model. `hashes` is every weight file whose sha256 is known for it: a single-file
// checkpoint, or the shards a repository publishes, each of which is a file a workflow could name. `verified` is not
// prose for its own sake — `assertModelRegistry` below requires that an entry with no hash says "cannot be verified
// here", so the absence is a statement rather than an omission.
export interface ModelEntry {
  readonly name: string
  // The SPDX identifier, or `LicenseRef-…` when the licence has no SPDX entry. Never a guess: see `verified`.
  readonly spdx: string
  readonly territories: readonly Territory[]
  // What the licence permits this project to do with it, in the words the licence uses.
  readonly use: string
  readonly hashes: readonly string[]
  readonly verified: string
}

// A model that may not be loaded at all. `hashes` is empty for the two D3 names because no copy of their weights was
// hashed on this machine, and inventing a hash would be worse than having none: an unknown hash is refused anyway, so a
// gap here cannot let one through. The guard that does bite without a hash is the name: `resolveModel` refuses a
// declared name that matches, and `registerModel` refuses to register one, so the block cannot be lifted by copying a
// name into the registry file.
export interface BlockedModel {
  readonly name: string
  readonly reason: string
  readonly hashes: readonly string[]
}

export interface ModelRegistry {
  readonly models: readonly ModelEntry[]
  readonly blocked: readonly BlockedModel[]
}

// ---------------------------------------------------------------------------------------------------------------------
// The table.

// Review note on every `verified` line: read 2026-11-16 from `https://huggingface.co/api/models/<repo>` (the `cardData`
// licence tag, the `blobs=true` LFS sha256 per file) and, for the two `LICENSE` texts, from the repository's own raw
// file. Those are the publisher's own statements; they are cited rather than paraphrased into "it is open".
export const MODEL_ENTRIES: readonly ModelEntry[] = [
  {
    name: "Wan 2.2 T2V-A14B",
    spdx: "Apache-2.0",
    territories: ["world"],
    use: "text-to-video generation (B2b's primary model, D4)",
    hashes: [
      "cb58f36df7e604c6e7b0df80a3f6f9b72c77695e581e19985fc3a0e6732ba1e2",
      "6719620a0feb4553d0306296ba4fad7d6d3b70b666fcbd02ad41fd21df3ab6af",
      "0eb7864481499e65698ab94ddfad00e1289960b9f1a45aed6530ba6701859513",
      "8646c9af94dbb2917380dbb6c2ba7fa34332566f2f9f0f508750e377fdad8e0a",
      "743ca2839d8339eeac1419de9bcfb6f02d4eab4264b01db6d4970047ae9385d0",
      "78e445e6ca232fb2b8669673b8f7e2f607f84b12e0489429577e8aea624ad7c1",
      "f2a6df8981742260b3f2cd8b51a276eb0ffa0332c9bbbadc3d625f269096f01c",
      "ea3998b0b394ede1df6c8cb9ea44f1bed0d3d7018bd8113baca9ff74e100b5d9",
      "e1222162ecdc5a8bb4815f78ae42951cdc3e50a3fe41d8f592462d28f8638681",
      "9fdd1165fe0c5efd87036b3722e69f1d2004bd27396905a997afb7ddf7f22edf",
      "04909e9fa1f15de79851230c7f223a0c96fcfd629bdd914b21c9344cec63c78a",
      "7a481d5adcc53ed3ae8b3222b4c4ee63bac6703dae9ff6c62a7d52e546c88809",
    ],
    verified:
      "licence tag apache-2.0 on Wan-AI/Wan2.2-T2V-A14B (read 2026-11-16); the twelve hashes are that repository's own " +
      "sha256 for the high-noise and low-noise diffusion shards. The weights ship as shards, not as one checkpoint: a " +
      "merged or quantised file has its own hash and is unknown here until it is registered",
  },
  {
    name: "Mochi 1 preview",
    spdx: "Apache-2.0",
    territories: ["world"],
    use: "text-to-video generation (D4 alternative)",
    hashes: [
      "5c273a0d4fbb0de835e31b7cb5228089ba0ee54d4c3a087e81d354cef3d8bbf1",
      "641920faaf20e5404ddb5553ce3e295c21ed9b4bc5f6fe7c930811b84099cb14",
      "d3a8827a66b58a479d97420a9bf77e59078d88f538298469d8db28c37bd556ae",
    ],
    verified:
      "licence tag apache-2.0 on genmo/mochi-1-preview (read 2026-11-16); the three hashes are that repository's own " +
      "sha256 for dit.safetensors, decoder.safetensors and encoder.safetensors. A merged checkpoint of the three has " +
      "its own hash and is unknown until registered",
  },
  {
    name: "CogVideoX-2B",
    spdx: "Apache-2.0",
    territories: ["world"],
    use: "text-to-video generation (D4 alternative)",
    hashes: ["8fbb6a5e67c70885a8ed8e33df144ac61253e45977be5035fa18cfdf77d386c7"],
    verified:
      "licence tag apache-2.0 on zai-org/CogVideoX-2b (read 2026-11-16); the hash is that repository's own sha256 for " +
      "the single transformer file",
  },
  {
    // The roadmap's "per-variant SPDX" note, settled: the 5B weights are not Apache-2.0. The tag is `other`, and the
    // LICENSE file grants a worldwide royalty-free licence for academic research, with commercial use only after a
    // registration with the licensor. Nothing in it excludes a territory, so the entry is permitted in the EU; what it
    // restricts is commercial use, which the `use` line states and this project does not do (D2).
    name: "CogVideoX-5B",
    spdx: "LicenseRef-CogVideoX",
    territories: ["world"],
    use:
      "academic research without further permission; commercial use only after registering for the licensor's basic " +
      "licence (free, at most 1,000,000 service visits per month)",
    hashes: [
      "b7101be7e75631130cdf4a63ad798452bdce29716aaa47829e882dd384c398bf",
      "ebe6c0e34a52c89f8ea8032a3a8a278a9ff1880dc70e1e6f3b840bcfd0396647",
    ],
    verified:
      "the 5B weights are NOT Apache-2.0: Hugging Face reports license: other for zai-org/CogVideoX-5b, and its LICENSE " +
      "(read 2026-11-16) grants a worldwide, non-exclusive, royalty-free licence for academic research, with commercial " +
      "use gated on registration with the licensor. The two hashes are that repository's own sha256 for the transformer " +
      "shards",
  },
  {
    name: "FLUX.1 schnell",
    spdx: "Apache-2.0",
    territories: ["world"],
    use: "text-to-image generation",
    hashes: ["9403429e0052277ac2a87ad800adece5481eecefd9ed334e1f348723621d2a0a"],
    verified:
      "licence tag apache-2.0 on black-forest-labs/FLUX.1-schnell (read 2026-11-16; the repository is gated on the " +
      "Hub, so a download needs an acceptance of that licence). The hash is that repository's own sha256 for " +
      "flux1-schnell.safetensors, the single file a checkpoint loader loads",
  },
  {
    name: "Qwen-Image",
    spdx: "Apache-2.0",
    territories: ["world"],
    use: "text-to-image generation",
    hashes: [
      "9f33a59093af3abcc2836d4cf4b7bd122c238ca70a26c70f34fdde64646b3bcd",
      "49d580e85b932e15c226e68a9d5549629878d3a128da7662d28401956cee0238",
      "0d72f0cbd0d6c2bdc2e1e73e41ac143452fc9e4570d1362203498832302de69f",
      "ee87991bfa1bc8e7553034b07099151532524101ca1581c4f3a86292814e9f0d",
      "83291a65be26fe688db4cf81383749831b623a6fcb1a71c851bafb55ddc0058d",
      "61e936a995e7f4ce08d44b9d6ffb56dc65dd61200288876ee2fda72da322583d",
      "854bc9e4a65c11c256f2fef31606a6407e9a425e8bde394db8be71416c515ead",
      "caedc7cc2914ab113cfbb3684cf072350201182ae8de1a7308e419385987ae40",
      "ae0fef149890f61d54572baa1e806de97156c7ec5b7bbbbbbf27a2d87f33af61",
    ],
    verified:
      "licence tag apache-2.0 on Qwen/Qwen-Image (read 2026-11-16); the nine hashes are that repository's own sha256 " +
      "for the transformer shards. A merged or quantised checkpoint has its own hash and is unknown until registered",
  },
  {
    // A different model from Qwen-Image, under a different licence, which is exactly why it is a separate entry and not
    // a second hash list on the entry above. It is also the one entry whose hash was checked on this machine: the Q4_K_M
    // GGUF installed under ~/Models hashes to the value below, which is the file unsloth/Qwen-Image-2.1-GGUF publishes.
    name: "Qwen-Image-2.1 (Q4_K_M GGUF)",
    spdx: "LicenseRef-Qwen-Research",
    territories: ["world"],
    use: "non-commercial: research and evaluation only; any commercial use needs a separate licence from the licensor",
    hashes: [
      "631d532e7ca71e8d90a87c71d3699761a812039d22e3370e87498d87754660fe",
      "9e6bc2d641e67bf277895ea8777141044a38f3edb7101bc469b2961dd7c36b4b",
      "3aaf234dcbe128530479735854a346b5e3e66283b7c11db56f836bbd1c13ebaa",
    ],
    verified:
      "the Qwen Research License Agreement, read 2026-11-16 from Qwen/Qwen-Image-2.1's LICENSE: non-exclusive, " +
      "worldwide, non-commercial only. The first hash was computed on this machine from " +
      "~/Models/image/qwen-image-2.1/gguf/qwen-image-2.1-Q4_K_M.gguf and matches the sha256 unsloth publishes for it; " +
      "the other two are the upstream transformer shards' published sha256",
  },
  {
    name: "SDXL base 1.0",
    spdx: "LicenseRef-CreativeML-OpenRAIL++-M",
    territories: ["world"],
    use: "text-to-image generation, including commercial use, subject to the OpenRAIL++ use restrictions",
    hashes: [
      "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
      "e6bb9ea85bbf7bf6478a7c6d18b71246f22e95d41bcdd80ed40aa212c33cfeff",
    ],
    verified:
      "Hugging Face reports license: openrail++ for stabilityai/stable-diffusion-xl-base-1.0 (read 2026-11-16), whose " +
      "licence is the CreativeML Open RAIL++-M, which has no SPDX identifier and is therefore recorded as a LicenseRef; " +
      "its LICENSE.md (read the same day) grants a perpetual, worldwide, royalty-free copyright and patent licence, " +
      "subject to the use restrictions in its attachment A. The two hashes are that repository's own sha256 for " +
      "sd_xl_base_1.0.safetensors and its 0.9-VAE variant",
  },
]

// D3, as data. Neither name has a hash here: no copy of either model's weights was on this machine and the table does
// not invent one. The refusal does not depend on that gap — an unknown hash is refused, and these two names are refused
// by name and refused registration — but it is stated so nobody reads the empty list as "well, then it is allowed".
export const BLOCKED_MODELS: readonly BlockedModel[] = [
  {
    name: "MiniMax H3",
    reason: "its open-weight licence excludes the EU, the UK and South Korea (D3)",
    hashes: [],
  },
  {
    name: "HunyuanVideo",
    reason: "its licence excludes the EU (D3)",
    hashes: [],
  },
]

export const MODEL_REGISTRY: ModelRegistry = { models: MODEL_ENTRIES, blocked: BLOCKED_MODELS }

// ---------------------------------------------------------------------------------------------------------------------
// Validation.

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isTerritory = (value: unknown): value is Territory =>
  typeof value === "string" && (TERRITORIES as readonly string[]).includes(value)

// A name as it is compared against the blocklist: case, spacing and punctuation are not what make two names the same
// model, so "Hunyuan Video" and "HunyuanVideo" are one refusal. Substring matching is deliberately absent — "Wan" must
// not block "Wan 2.2".
export const nameKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "")

// Refuse a table that is internally inconsistent, for the same reason `assertRegistry` refuses a broken checks registry:
// a table that ships has passed this function, and a reader never has to cope with half a meaning. The rule the roadmap
// asks for is the last one: an entry is verifiable here exactly when it lists a hash, and an entry that does not must
// say so in the words "cannot be verified here".
export function assertModelRegistry(registry: ModelRegistry): void {
  const names = new Set<string>()
  const hashes = new Map<string, string>()
  for (const entry of registry.models) {
    const label = `model ${shown(entry.name)}`
    if (!entry.name.trim()) throw new Error("model registry: an entry has no name")
    const key = nameKey(entry.name)
    if (names.has(key)) throw new Error(`model registry: ${label} is listed twice`)
    names.add(key)
    if (!entry.spdx.trim()) throw new Error(`model registry: ${label} has no licence`)
    if (!entry.use.trim()) throw new Error(`model registry: ${label} has no stated use`)
    if (!entry.verified.trim()) throw new Error(`model registry: ${label} does not say how it was verified`)
    if (entry.territories.length === 0) throw new Error(`model registry: ${label} permits no territory`)
    for (const territory of entry.territories) {
      if (!isTerritory(territory)) throw new Error(`model registry: ${label} names an unknown territory ${shown(territory)}`)
    }
    for (const hash of entry.hashes) {
      if (!SHA256.test(hash)) throw new Error(`model registry: ${label} has a hash that is not a lowercase sha256: ${shown(hash)}`)
      const first = hashes.get(hash)
      if (first !== undefined) throw new Error(`model registry: the hash ${hash} is claimed by both ${first} and ${entry.name}`)
      hashes.set(hash, entry.name)
    }
    if (entry.hashes.length === 0 && !entry.verified.includes("cannot be verified here")) {
      throw new Error(
        `model registry: ${label} lists no hash, so it must say "cannot be verified here" — an entry with neither is a claim nobody checked`,
      )
    }
  }
  for (const blocked of registry.blocked) {
    if (!blocked.name.trim()) throw new Error("model registry: a blocked entry has no name")
    if (!blocked.reason.trim()) throw new Error(`model registry: blocked ${shown(blocked.name)} has no reason`)
    for (const hash of blocked.hashes) {
      if (!SHA256.test(hash)) throw new Error(`model registry: blocked ${shown(blocked.name)} has a hash that is not a sha256`)
      if (hashes.has(hash)) throw new Error(`model registry: ${hash} is both allowed (${hashes.get(hash)}) and blocked (${blocked.name})`)
    }
  }
}

assertModelRegistry(MODEL_REGISTRY)

// ---------------------------------------------------------------------------------------------------------------------
// Resolution.

export interface ModelQuery {
  // What the spec called it. Never used to allow anything: it is compared against the blocklist and otherwise only
  // appears in the sentence a refusal carries.
  readonly declared?: string
  // The sha256 of the weights: computed from the file when the file is here, declared by the spec when it is not.
  readonly hash?: string
  readonly territory?: Territory
}

// What a caller fills in to register an unknown checkpoint. The licence is left empty on purpose: an offer that already
// contained "Apache-2.0" would be this package making a licence claim on the user's behalf.
export interface ModelOffer {
  readonly hash?: string
  readonly name?: string
  readonly license: string
  readonly territory: Territory
}

export type ModelVerdict =
  | {
      readonly status: "allowed"
      readonly hash: string
      readonly name: string
      readonly spdx: string
      readonly territories: readonly Territory[]
      readonly use: string
      readonly verified: string
      readonly territory: Territory
      readonly reason: string
    }
  | { readonly status: "blocked"; readonly name: string; readonly hash?: string; readonly reason: string }
  | { readonly status: "unknown"; readonly hash?: string; readonly declared?: string; readonly reason: string; readonly offer: ModelOffer }
  | {
      readonly status: "territory"
      readonly hash: string
      readonly name: string
      readonly spdx: string
      readonly territory: Territory
      readonly reason: string
    }

const permitted = (entry: ModelEntry, territory: Territory): boolean =>
  entry.territories.includes(territory) || entry.territories.includes("world")

const hashOf = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const lower = value.toLowerCase()
  return SHA256.test(lower) ? lower : undefined
}

// The policy, in one function. Order matters: the blocklist is asked first (a blocked model is blocked whatever its
// territory says), then the registry, then the territory. A hash that is not 64 lowercase hex characters is not a hash a
// file can have, which is the unknown case — the sentence quotes it so the reader sees what was compared.
export function resolveModel(query: ModelQuery, registry: ModelRegistry = MODEL_REGISTRY): ModelVerdict {
  const territory = query.territory ?? DEFAULT_TERRITORY
  if (!isTerritory(territory)) throw new Error(`model registry: unknown territory ${shown(territory)}`)
  const declared = query.declared?.trim() || undefined
  const hash = hashOf(query.hash)

  const block = registry.blocked.find((entry) => hash !== undefined && entry.hashes.includes(hash))
  if (block !== undefined && hash !== undefined) {
    return {
      status: "blocked",
      name: block.name,
      hash,
      reason: `checkpoint sha256 ${hash} is blocked as ${shown(block.name)}: ${block.reason}; it is refused and not loaded`,
    }
  }
  // A declared name that matches a blocked model is refused too. A name cannot allow anything, but it can refuse: the
  // two D3 models have no hash in this table, and without this line the only sentence they would get is the unknown one.
  if (declared !== undefined) {
    const byName = registry.blocked.find((entry) => nameKey(entry.name) === nameKey(declared))
    if (byName !== undefined) {
      return {
        status: "blocked",
        name: byName.name,
        ...(hash !== undefined ? { hash } : {}),
        reason: `checkpoint ${shown(declared)} is blocked as ${shown(byName.name)}: ${byName.reason}; it is refused and not loaded`,
      }
    }
  }

  const entry = hash === undefined ? undefined : registry.models.find((candidate) => candidate.hashes.includes(hash))
  if (hash !== undefined && entry !== undefined) {
    if (!permitted(entry, territory)) {
      const where = entry.territories.join(", ")
      return {
        status: "territory",
        hash,
        name: entry.name,
        spdx: entry.spdx,
        territory,
        reason: `checkpoint sha256 ${hash} (${shown(entry.name)}, ${entry.spdx}) may not be used in ${territory}: its licence permits ${where}`,
      }
    }
    return {
      status: "allowed",
      hash,
      name: entry.name,
      spdx: entry.spdx,
      territories: entry.territories,
      use: entry.use,
      verified: entry.verified,
      territory,
      reason: `checkpoint sha256 ${hash} is ${shown(entry.name)} under ${entry.spdx}, which permits use in ${territory}`,
    }
  }

  const offer: ModelOffer = {
    ...(hash !== undefined ? { hash } : {}),
    ...(declared !== undefined ? { name: declared } : {}),
    license: "",
    territory,
  }
  const wanted = declared !== undefined ? ` ${shown(declared)}` : ""
  const sentence =
    hash !== undefined
      ? `checkpoint sha256 ${hash}${wanted ? ` (${wanted.trim()})` : ""} is not in the model registry, so it is refused: a name proves nothing, because a workflow can load any checkpoint on disk. Register it with its licence and territory — registerModel({ hash, name, license, territory }) — and it is allowed from then on`
      : `checkpoint${wanted} has no sha256 to resolve, so it is refused: a name proves nothing, because a workflow can load any checkpoint on disk. Give the slot the file's sha256, or register it with its licence and territory — registerModel({ hash, name, license, territory })`
  return {
    status: "unknown",
    ...(hash !== undefined ? { hash } : {}),
    ...(declared !== undefined ? { declared } : {}),
    reason: sentence,
    offer,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration: the one write.

// Where the user's own records live: the same per-user state directory the journal uses. Spelled here rather than
// imported from `@omacode/core` because this package must not depend on the orchestrator that depends on it, and the
// path is a contract neither package owns alone — a move changes both, and that is a smaller cost than a cycle.
export function modelsDir(dir?: string): string {
  return dir ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "micromanager")
}

export function modelsPath(dir?: string): string {
  return join(modelsDir(dir), "models.json")
}

export interface ModelRegistration {
  readonly hash: string
  readonly name: string
  // An SPDX identifier, or a LicenseRef. Required: D18 refuses a checkpoint whose licence nobody stated.
  readonly license: string
  readonly territory: Territory | readonly Territory[]
  readonly use?: string
}

const REGISTRY_VERSION = 1

interface RegistryFile {
  readonly version: number
  readonly models: readonly ModelEntry[]
}

// One entry as a registry file may hold it. The parse is strict for the same reason the spec's is: a hand-edited file
// is expected to be edited, and an entry that lost its licence has to be refused rather than defaulted — a default
// licence is a licence nobody granted.
function entryFrom(value: unknown, at: string): { entry?: ModelEntry; errors: readonly string[] } {
  const errors: string[] = []
  if (!isRecord(value)) return { errors: [`${at}: expected an object, got ${typeof value}`] }

  const allowed = ["name", "spdx", "territories", "use", "hashes", "verified"]
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${at}.${key}: unknown key`)
  }
  const name = value["name"]
  if (typeof name !== "string" || !name.trim()) errors.push(`${at}.name: expected a non-empty model name`)
  const spdx = value["spdx"]
  if (typeof spdx !== "string" || !spdx.trim()) errors.push(`${at}.spdx: expected a non-empty licence identifier`)

  const territories: Territory[] = []
  const listed = value["territories"]
  if (!Array.isArray(listed) || listed.length === 0) {
    errors.push(`${at}.territories: expected at least one territory`)
  } else {
    for (const [index, territory] of listed.entries()) {
      if (!isTerritory(territory)) errors.push(`${at}.territories[${index}]: expected one of ${TERRITORIES.join(", ")}, got ${shown(territory)}`)
      else territories.push(territory)
    }
  }

  const use = value["use"]
  if (typeof use !== "string" || !use.trim()) errors.push(`${at}.use: expected a non-empty description of the permitted use`)

  const hashes: string[] = []
  const listed2 = value["hashes"]
  if (!Array.isArray(listed2) || listed2.length === 0) {
    errors.push(`${at}.hashes: a registered model needs the hash it is registered for`)
  } else {
    for (const [index, hash] of listed2.entries()) {
      if (typeof hash !== "string" || !SHA256.test(hash)) {
        errors.push(`${at}.hashes[${index}]: expected a lowercase sha256 digest, got ${shown(hash)}`)
      } else hashes.push(hash)
    }
  }

  const verified = value["verified"]
  if (verified !== undefined && (typeof verified !== "string" || !verified.trim())) {
    errors.push(`${at}.verified: expected a non-empty string when it is present`)
  }

  if (errors.length > 0) return { errors }
  return {
    entry: {
      name: name as string,
      spdx: spdx as string,
      territories,
      use: use as string,
      hashes,
      verified: (verified as string | undefined) ?? "registered by the user with registerModel; not verified by this package",
    },
    errors,
  }
}

// Read the user's registry. A missing file is not an error — it is the state before the first registration, which is the
// state every machine starts in. A file that is present but wrong is an error the caller must refuse on: silently
// ignoring a broken registry would turn a user's edit into "no restrictions recorded", which is the failure this whole
// module exists to prevent.
export function readModelRegistry(options: { readonly dir?: string } = {}): { readonly entries: readonly ModelEntry[]; readonly errors: readonly string[] } {
  const path = options.dir !== undefined ? modelsPath(options.dir) : modelsPath()
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : ""
    if (code === "ENOENT") return { entries: [], errors: [] }
    return { entries: [], errors: [`${path}: cannot be read (${error instanceof Error ? error.message : String(error)})`] }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { entries: [], errors: [`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  if (!isRecord(value)) return { entries: [], errors: [`${path}: expected an object, got ${shown(value)}`] }
  if (value["version"] !== REGISTRY_VERSION) {
    return { entries: [], errors: [`${path}: version ${shown(value["version"])}, expected ${REGISTRY_VERSION}`] }
  }
  const models = value["models"]
  if (!Array.isArray(models)) return { entries: [], errors: [`${path}: models: expected an array, got ${shown(models)}`] }

  const errors: string[] = []
  const entries: ModelEntry[] = []
  models.forEach((item, index) => {
    const parsed = entryFrom(item, `models[${index}]`)
    errors.push(...parsed.errors)
    if (parsed.entry !== undefined) entries.push(parsed.entry)
  })
  // The whole file is refused when one entry is wrong: a half-read registry would allow the entries that happened to
  // parse while the user believed the file said something about all of them.
  if (errors.length === 0) {
    try {
      assertModelRegistry({ models: entries, blocked: [] })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return errors.length > 0 ? { entries: [], errors: errors.map((error) => `${path}: ${error}`) } : { entries, errors: [] }
}

// A registry with the user's entries in front of the code table's. Registered entries are consulted first because they
// are the answer to a question this package asked: the user said what this checkpoint is and what its licence permits.
// A registered hash that a table entry already lists shadows it (the registration is newer and explicit), and a hash
// that a blocked entry lists is refused by `registerModel` before it ever gets here.
export function registryWith(entries: readonly ModelEntry[], base: ModelRegistry = MODEL_REGISTRY): ModelRegistry {
  const known = new Set(entries.flatMap((entry) => entry.hashes))
  return {
    models: [...entries, ...base.models.filter((entry) => entry.hashes.every((hash) => !known.has(hash)))],
    blocked: base.blocked,
  }
}

// Register an unknown checkpoint. The rules are D18's written down: a hash has to be a hash, a licence has to be stated,
// a territory has to be one this table knows, and a blocked model cannot be registered at all. An existing file is read
// first — a broken one is not overwritten, because the person who edited it would lose what they wrote and would not
// learn that the file was the reason nothing worked.
export function registerModel(
  input: ModelRegistration,
  options: { readonly dir?: string } = {},
): { readonly path: string; readonly entry: ModelEntry } {
  const hash = input.hash.toLowerCase()
  if (!SHA256.test(hash)) throw new Error(`registerModel: hash: expected a lowercase sha256 digest of 64 hex characters, got ${shown(input.hash)}`)
  const name = input.name.trim()
  if (!name) throw new Error("registerModel: name: expected a non-empty model name")
  const spdx = input.license.trim()
  if (!spdx) throw new Error("registerModel: license: expected an SPDX identifier or a LicenseRef; a checkpoint is not allowed without one")
  const territories = Array.isArray(input.territory) ? [...input.territory] : [input.territory as Territory]
  if (territories.length === 0) throw new Error("registerModel: territory: expected at least one territory")
  for (const territory of territories) {
    if (!isTerritory(territory)) {
      throw new Error(`registerModel: territory: expected one of ${TERRITORIES.join(", ")}, got ${shown(territory)}`)
    }
  }
  const use = input.use?.trim() || "registered for local generation by the user"

  const blocked = MODEL_REGISTRY.blocked.find((entry) => entry.hashes.includes(hash) || nameKey(entry.name) === nameKey(name))
  if (blocked !== undefined) {
    throw new Error(`registerModel: ${shown(name)} is blocked as ${shown(blocked.name)}: ${blocked.reason}; it cannot be registered`)
  }

  const path = options.dir !== undefined ? modelsPath(options.dir) : modelsPath()
  const existing = readModelRegistry(options)
  if (existing.errors.length > 0) {
    throw new Error(`registerModel: nothing is written, because the registry file cannot be read: ${existing.errors.join("; ")}`)
  }

  const entry: ModelEntry = {
    name,
    spdx,
    territories,
    use,
    hashes: [hash],
    verified: "registered by the user with registerModel; the licence and territory are the user's statement, not this package's",
  }
  const models = [entry, ...existing.entries.filter((known) => !known.hashes.includes(hash) && nameKey(known.name) !== nameKey(name))]

  const file: RegistryFile = { version: REGISTRY_VERSION, models }
  assertModelRegistry({ models, blocked: [] })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${canonicalJson(file)}\n`, { encoding: "utf8", mode: 0o600 })
  chmodSync(path, 0o600)
  return { path, entry }
}
