---
name: deck
description: Build and check an HTML deck with the deck adapter. Use when a task produces slides, a presentation or a talk, or when a deck has to pass its checks before it is presented.
license: Apache-2.0
metadata:
  source: own
  verified_against: hyperframes 0.9.54, its slideshow manifest and `hyperframes check --json`
---

# Deck

A deck is data first: a `DeckSpec` (version 2) of slides, notes, reveals, branches and hotspots. The deck adapter
writes it as a HyperFrames project, the engine's own checks decide whether it may be presented, and the quality gate
decides whether it is worth presenting. Your job is the spec and its content, not the HTML.

## What the spec says

A complete `deck.json`; `kind`, `version`, `job`, `brief` and `slides` are required, and there is no top-level `title`:

```json
{
  "kind": "deck",
  "version": 2,
  "job": "local-ai",
  "brief": "Why run AI models on your own computer",
  "slides": [
    { "id": "intro", "title": "Your AI, your machine", "body": "Why run models at home", "notes": "Open with the question." },
    { "id": "privacy", "title": "Privacy", "body": "Nothing leaves the machine\nNo account, no upload", "notes": "Two points, one per click.", "reveals": [0, 1] }
  ]
}
```

- `job` is a short name for this deck (letters, digits, `-`); `brief` is one sentence on what it is for.
- `slides[]`, each with `id`, `title`, `body`, `notes`, and optionally `asset`, `reveals`, `hotspots`, `hidden`.
- `branches[]` are the optional paths off a slide; a `hotspot` with `target` names one. The main line's id `main` is
  the player's, so a branch cannot use it.
- `reveals` are line indices of the slide's `body` (lines split at `\n`, counted from 0): each named line appears on
  its own click, in ascending order, after the slide has come up with its other lines. They are not seconds.
  `"body": "Point\nDetail one\nDetail two", "reveals": [1, 2]` shows "Point", then "Detail one", then "Detail two".
- Every path is relative to the job directory. An absolute path, a `..` or a backslash is refused, as is a slide id
  that is used twice or a hotspot that points at a branch that does not exist.

## What the deck must survive

The adapter runs the engine's checks, and each one can fail:

- **slide count** — the rendered deck has a scene per visible slide; a hidden slide is not a scene.
- **overflow** — no text leaves its box, at nine sampled moments.
- **contrast** — every text pair passes WCAG AA; grey on grey fails even when it "looks fine".
- **notes** — every visible slide has speaker notes; a deck read aloud without them is not finished.
- **unresolved targets** — every `img`, audio and stylesheet reference points at a file in the project. An `<a href>`
  is **not** checked by the engine; if a slide links somewhere, say so in the notes so a reader knows.
- **branch** — every hotspot names a branch, and every branch slide is a scene.
- **snapshots** — one frame per slide, and no frame is blank (99.9 % of one colour).
- **presenter** — a probe opens `hyperframes present` in a real browser and steps through every slide and reveal:
  exactly one slide on stage at each step, its title shown, no console error. This is what the audience sees; a
  deck can pass every frame check and still fail here.

In the presenter each slide comes up with a short rise-in of its rule, title and lines; snapshots and checks see the
finished slide. You do not write animation code: the adapter owns the HTML.

A missing picture is not a failure: it becomes a labelled placeholder (`missing asset: <path>`), and the check names it.
Write the path you meant anyway — the placeholder is how the deck stays presentable while the image is still missing.

## Presenting

`hyperframes present` serves the deck; `hyperframes render` is for video compositions and is **never** run on a deck.
The presenter needs the host's network because its server listens inside the sandbox, which is the one call the adapter
runs unwrapped; every check runs without it.

## When something fails

Fix the spec or the content, not the check. A slide that overflows needs fewer words, not a smaller font; a slide
without notes needs the sentence you would have said. If a check is `skipped` with a reason (no vision model, an
unsupported frame), say so in the report — a skipped check is an absence, never a pass.
