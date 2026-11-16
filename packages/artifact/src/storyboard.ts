// The storyboard (B2-T3): a video's beats written down as a table a person can edit. A `VideoSpec` says what the film is
// — scenes, durations, captions, acceptance — but it says nothing about why a scene exists or what the camera is meant to
// be doing in it. The storyboard is that half: one row per beat, and the row carries the beat sheet (`what`), the shot
// list (`shot`), the words on screen or in the script (`words`) and what the beat has to achieve (`acceptance`).
//
// The types here are the plan, not the contract. `spec.ts` still owns what an adapter renders, and a beat is not a scene:
// it has no asset, no fps and no size. `storyboardFromPlan` is the bridge in the direction the handoff already works
// (B1-T6): plan.md is prose, a storyboard is prose made addressable, and the two defaults a plan never carries — a
// duration and an acceptance line — are stated here rather than invented by the adapter.
//
// The file format is a Markdown table because the person fixing a beat should not have to read JSON. Parsing is strict
// about the things a later check depends on — the six column names, one row per beat, a number for `at`, an id that can
// become a scene id, and at least one acceptance line per beat — and lenient about the prose around it, so notes below the
// table survive an edit. A beat without acceptance is refused: a promise nobody wrote down is not a promise a check can
// keep, and this is the file where it would have been written.

// The one duration a plan that says nothing else gets. It is the same number the handoff uses for a scene (B1-T6), and it
// is stated in every note that relies on it, because a default a reader cannot see is a number this module invented.
export const DEFAULT_BEAT_SECONDS = 5

// A beat id becomes a scene id, which becomes a `data-composition-id` in the page (the video adapter's own rule). The
// storyboard refuses a name the adapter would refuse, so a board that parses can also be rendered.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// One beat. `at` is the second the beat starts, so the film's order is the table's order and the last beat's length is
// the board's duration minus its start. That is why the board carries a duration: a table of starts cannot say how long
// the final shot is held.
export interface Beat {
  readonly id: string
  readonly at: number
  readonly what: string
  readonly shot: string
  readonly words?: string
  readonly acceptance: readonly string[]
}

export interface Storyboard {
  readonly job: string
  readonly duration: number
  readonly beats: readonly Beat[]
}

// What a plan says about one scene before it is a beat. Every field but the id is optional because this is the shape a
// plan's prose arrives in: a promoted clip gives an asset and a name, and nothing else.
export interface PlanScene {
  readonly id: string
  readonly title?: string
  readonly duration?: number
  readonly asset?: string
  readonly captions?: readonly string[]
  readonly acceptance?: readonly string[]
}

// The prose a plan leaves (A1-T8) and the scenes its promoted assets become. `findings` and `decisions` are the lines
// that make a beat more than its title; a plan with none still has a goal, and that is enough for a one-beat board.
export interface StoryboardPlan {
  readonly job: string
  readonly goal: string
  readonly findings?: readonly string[]
  readonly decisions?: readonly string[]
  readonly scenes: readonly PlanScene[]
}

export interface StoryboardBuild {
  readonly storyboard?: Storyboard
  readonly errors: readonly string[]
  // What was defaulted rather than read, in the same spirit as the handoff's warnings: a duration the plan did not
  // carry, an acceptance line the plan did not write. A caller shows these; a silent default is a lie of omission.
  readonly notes: readonly string[]
}

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value)

// A second with milliseconds kept and trailing zeros dropped, so the same board always writes the same bytes.
const seconds = (value: number): number => Math.round(value * 1000) / 1000
const secondsText = (value: number): string => String(seconds(value))

const blank = (value: string): boolean => value.trim().length === 0

// A line that cannot sit in a table cell. A newline would end the row, so it is refused where it is written rather than
// silently folded into a space that changes the words.
const oneLine = (value: string): boolean => !value.includes("\n") && !value.includes("\r")

// Why a board cannot be rendered or trusted. Addressed the way the table is read, so the person fixing a row knows which
// one: `beats[1].acceptance`. Every rule is a property the storyboard's own consumers rely on — the adapter needs the id
// and the duration, a later check needs the at and the acceptance.
export function storyboardProblems(storyboard: Storyboard): readonly string[] {
  const problems: string[] = []
  if (blank(storyboard.job)) problems.push("job: a storyboard needs the job it belongs to")
  else if (!oneLine(storyboard.job)) problems.push("job: the title holds one line, and this job has a newline in it")
  if (!(storyboard.duration > 0) || !Number.isFinite(storyboard.duration)) {
    problems.push(`duration: ${shown(storyboard.duration)} is not a number of seconds greater than 0`)
  }
  if (storyboard.beats.length === 0) {
    problems.push("beats: a storyboard with no beat would render an empty film")
    return problems
  }

  const seen = new Set<string>()
  let previous = -1
  storyboard.beats.forEach((beat, index) => {
    const at = `beats[${index}]`
    if (!SAFE_ID.test(beat.id)) {
      problems.push(`${at}.id: ${shown(beat.id)} is not a safe scene id (${SAFE_ID.source})`)
    } else if (seen.has(beat.id)) {
      problems.push(`${at}.id: ${shown(beat.id)} is used twice`)
    }
    seen.add(beat.id)
    if (!Number.isFinite(beat.at) || beat.at < 0) {
      problems.push(`${at}.at: ${shown(beat.at)} is not a second greater than or equal to 0`)
    } else {
      if (index === 0 && beat.at !== 0) problems.push(`${at}.at: the first beat starts at ${shown(beat.at)} s, not 0`)
      if (beat.at <= previous) problems.push(`${at}.at: ${shown(beat.at)} s is not after the beat before it (${shown(previous)} s)`)
      if (beat.at >= storyboard.duration) {
        problems.push(`${at}.at: ${shown(beat.at)} s is not inside a ${shown(storyboard.duration)} s board`)
      }
      previous = beat.at
    }
    for (const field of ["what", "shot"] as const) {
      const value = beat[field]
      if (blank(value)) problems.push(`${at}.${field}: a beat needs a ${field === "what" ? "beat sheet line" : "shot list line"}`)
      else if (!oneLine(value)) problems.push(`${at}.${field}: a table cell holds one line, and this one holds a newline`)
    }
    if (beat.words !== undefined) {
      if (blank(beat.words)) problems.push(`${at}.words: an empty string says what no words would say; leave the field out`)
      else if (!oneLine(beat.words)) problems.push(`${at}.words: a table cell holds one line, and this one holds a newline`)
    }
    if (beat.acceptance.length === 0) {
      problems.push(`${at}.acceptance: a beat with no acceptance is a scene nothing can later be checked against`)
    }
    beat.acceptance.forEach((line, lineIndex) => {
      if (blank(line)) problems.push(`${at}.acceptance[${lineIndex}]: a blank line accepts nothing`)
      else if (!oneLine(line)) problems.push(`${at}.acceptance[${lineIndex}]: a table cell holds one line`)
    })
  })
  return problems
}

// The prose a beat's `what` can be drawn from, in the order a reader would trust it: what the job is for, then what was
// found, then what was decided. Empty lines are dropped rather than becoming an empty cell.
function proseOf(plan: StoryboardPlan): readonly string[] {
  return [plan.goal, ...(plan.findings ?? []), ...(plan.decisions ?? [])].map((line) => line.trim()).filter((line) => line.length > 0)
}

// What the camera is doing. A beat with an asset is that asset held for the beat; a beat without one is the writer's
// title card, which is what the video adapter draws when a scene has no picture. The shot column is where a person
// changes that sentence, so it says the decision and not the CSS.
function shotOf(scene: PlanScene, label: string): string {
  return scene.asset === undefined
    ? `a title card: "${label}"`
    : `the clip ${scene.asset}, held for the beat`
}

// The words on screen. B2 has no narration, so the words are what the frame carries: the scene's captions when it has
// them, and otherwise its title. A scene with neither says nothing, and the column stays empty.
function wordsOf(scene: PlanScene): string | undefined {
  const captions = (scene.captions ?? []).map((line) => line.trim()).filter((line) => line.length > 0)
  if (captions.length > 0) return captions.join(" / ")
  const title = (scene.title ?? "").trim()
  return title.length > 0 ? title : undefined
}

// The acceptance a plan did not write. The two lines are the smallest promises the finished film can be looked at and
// kept or broken: the beat really occupies its window, and the frame at its midpoint really shows the thing the beat is
// about. They are deliberately mechanical — a scene the writer has an opinion about brings its own lines.
function defaultAcceptance(scene: PlanScene, at: number, duration: number, label: string): readonly string[] {
  const midpoint = seconds(at + duration / 2)
  return [
    `beat ${scene.id} is on screen from ${secondsText(at)} to ${secondsText(seconds(at + duration))} s`,
    scene.asset === undefined
      ? `the frame at ${secondsText(midpoint)} s shows the words "${label}"`
      : `the frame at ${secondsText(midpoint)} s shows ${scene.asset}`,
  ]
}

// A plan turned into beats. The duration and the acceptance are the two things a plan.md shape does not carry, so they
// are stated here — the duration in a note per scene that needed it, the acceptance in one note for the board — and the
// resulting board is validated before it is handed back. A plan that says nothing at all (no goal, no finding, no
// decision) has no beat sheet to write and is refused rather than filled with the scene ids twice.
export function storyboardFromPlan(plan: StoryboardPlan): StoryboardBuild {
  const errors: string[] = []
  const notes: string[] = []
  const prose = proseOf(plan)
  if (prose.length === 0) {
    return {
      errors: ["the plan has no goal, finding or decision, so a storyboard would have no beat sheet to write"],
      notes,
    }
  }
  if (plan.scenes.length === 0) {
    return { errors: ["the plan promotes nothing a video can use, so there are no beats"], notes }
  }

  const beats: Beat[] = []
  let at = 0
  let defaultedAcceptance = 0
  plan.scenes.forEach((scene, index) => {
    const duration = scene.duration ?? DEFAULT_BEAT_SECONDS
    if (!(duration > 0) || !Number.isFinite(duration)) {
      errors.push(`scenes[${index}].duration: ${shown(duration)} is not a number of seconds greater than 0`)
      return
    }
    if (scene.duration === undefined) {
      notes.push(
        `${scene.asset ?? scene.id}: plan.md carries no duration, so the beat uses the default ${DEFAULT_BEAT_SECONDS} s`,
      )
    }
    const label = (scene.title ?? "").trim() || scene.id
    const acceptance = (scene.acceptance ?? []).map((line) => line.trim()).filter((line) => line.length > 0)
    if (acceptance.length === 0) defaultedAcceptance += 1
    const words = wordsOf(scene)
    beats.push({
      id: scene.id,
      at: seconds(at),
      what: prose[index % prose.length]!,
      shot: shotOf(scene, label),
      ...(words !== undefined ? { words } : {}),
      acceptance: acceptance.length > 0 ? acceptance : defaultAcceptance(scene, at, duration, label),
    })
    at = seconds(at + duration)
  })
  if (errors.length > 0) return { errors, notes }

  if (defaultedAcceptance > 0) {
    notes.push(
      `plan.md carries no acceptance for ${defaultedAcceptance} of ${plan.scenes.length} beats, so each states the window it fills and what its midpoint frame shows`,
    )
  }

  const storyboard: Storyboard = { job: plan.job, duration: seconds(at), beats }
  const problems = storyboardProblems(storyboard)
  if (problems.length > 0) return { errors: problems, notes }
  return { storyboard, errors, notes }
}

// ---------------------------------------------------------------------------------------------------------------------
// The table. Six columns, one row per beat, and a duration line above it because the last beat's length is the board's
// duration minus its start. A bar inside a cell is escaped, so a caption that says "A | B" survives the round trip.

const HEAD = ["beat", "at", "what", "shot", "words", "acceptance"] as const
const HEADER = `| ${HEAD.join(" | ")} |`
const RULE = `| ${HEAD.map(() => "---").join(" | ")} |`

// The separator between two acceptance lines inside one cell. It is the middle dot the plan's own task lines use, with
// spaces, which is unlikely to be prose and is easy to see in a diff.
const LINE_SEPARATOR = " · "

const escapeCell = (value: string): string => value.replace(/\|/g, "\\|")

// One row of a table, split on its unescaped bars. The leading and trailing empty fields a row's outer bars produce are
// dropped, so `| a | b |` is two cells and not four.
function cellsOf(line: string): readonly string[] {
  const text = line.trim()
  if (!text.startsWith("|")) return []
  let end = text.length
  if (text.endsWith("|") && !text.endsWith("\\|")) end -= 1
  const cells: string[] = []
  let current = ""
  for (let index = 1; index < end; index += 1) {
    const char = text[index]!
    if (char === "\\" && text[index + 1] === "|") {
      current += "|"
      index += 1
    } else if (char === "|") {
      cells.push(current.trim())
      current = ""
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

// The document. A board with a problem is refused here rather than written: a table that cannot be parsed back is a
// document that looks editable and is not.
export function renderStoryboard(storyboard: Storyboard): string {
  const problems = storyboardProblems(storyboard)
  if (problems.length > 0) throw new Error(`storyboard: ${problems.join("; ")}`)
  const rows = storyboard.beats.map((beat) =>
    [
      beat.id,
      secondsText(beat.at),
      beat.what,
      beat.shot,
      beat.words ?? "",
      beat.acceptance.join(LINE_SEPARATOR),
    ]
      .map(escapeCell)
      .join(" | "),
  )
  return [
    `# ${storyboard.job} — storyboard`,
    "",
    `Duration: ${secondsText(storyboard.duration)} s`,
    "",
    HEADER,
    RULE,
    ...rows.map((row) => `| ${row} |`),
    "",
  ].join("\n")
}

// A non-negative number of seconds from a cell, or undefined when the cell is not one. An empty cell is not zero: a
// missing `at` is a row the reader has to fix, and `Number("")` would silently make it the first beat.
function atOf(cell: string): number | undefined {
  if (cell === "" || !/^\d+(\.\d+)?$/.test(cell)) return undefined
  const value = Number(cell)
  return Number.isFinite(value) ? value : undefined
}

// Read a storyboard back. The title, the Duration line and the exact six-column table are required; anything after the
// table is prose a person added and is left alone. Errors are addressed as `beats[2].at`, so a row that is wrong is the
// row the reader is sent to.
export function parseStoryboard(text: string): { storyboard?: Storyboard; errors: string[] } {
  const errors: string[] = []
  const lines = text.split(/\r?\n/)

  let job = ""
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line))
  if (titleIndex < 0) {
    errors.push('the storyboard has no title; it must read "# <job> — storyboard"')
  } else {
    const title = /^#\s+(.*?)\s*$/.exec(lines[titleIndex]!)?.[1] ?? ""
    const found = /^(.*?)\s+[—–-]\s+storyboard$/.exec(title)
    if (found === null || blank(found[1]!)) {
      errors.push(`the title must read "# <job> — storyboard", got ${shown(title)}`)
    } else {
      job = found[1]!.trim()
    }
  }

  let duration: number | undefined
  const durationIndex = lines.findIndex((line) => /^Duration:/.test(line))
  if (durationIndex < 0) {
    errors.push('the storyboard has no "Duration: <seconds> s" line')
  } else {
    const said = /^Duration:\s*(.*?)\s*s$/.exec(lines[durationIndex]!)
    const value = said === null ? undefined : atOf(said[1]!)
    if (value === undefined || value <= 0) {
      errors.push(`Duration: expected a number of seconds greater than 0, got ${shown(lines[durationIndex])}`)
    } else {
      duration = value
    }
  }

  const headerIndex = lines.findIndex((line) => {
    const cells = cellsOf(line)
    return cells.length === HEAD.length && cells.every((cell, index) => cell === HEAD[index])
  })
  const beats: Beat[] = []
  if (headerIndex < 0) {
    errors.push(`the beat table has no "${HEADER}" header`)
  } else {
    const rule = lines[headerIndex + 1]?.trim()
    if (rule === undefined || cellsOf(rule).length !== HEAD.length || !cellsOf(rule).every((cell) => /^-+$/.test(cell))) {
      errors.push(`the beat table has no rule under its header; expected "${RULE}"`)
    }
    for (let index = headerIndex + 2; index < lines.length; index += 1) {
      const line = lines[index]!
      if (blank(line)) break
      if (!line.trim().startsWith("|")) break
      const cells = cellsOf(line)
      const at = `beats[${beats.length}]`
      if (cells.length !== HEAD.length) {
        errors.push(`${at}: expected ${HEAD.length} cells (${HEAD.join(", ")}), got ${cells.length}`)
        continue
      }
      const start = atOf(cells[1]!)
      if (start === undefined) {
        errors.push(`${at}.at: expected a non-negative number of seconds, got ${shown(cells[1]!)}`)
      }
      const acceptance = cells[5] === "" ? [] : cells[5]!.split(LINE_SEPARATOR).map((line) => line.trim())
      beats.push({
        id: cells[0]!,
        at: start ?? 0,
        what: cells[2]!,
        shot: cells[3]!,
        ...(cells[4] !== "" ? { words: cells[4]! } : {}),
        acceptance,
      })
    }
  }

  if (duration === undefined) {
    return { errors }
  }
  const storyboard: Storyboard = { job, duration, beats }
  const problems = storyboardProblems(storyboard)
  if (problems.length > 0) errors.push(...problems)
  return errors.length > 0 ? { errors } : { storyboard, errors }
}
