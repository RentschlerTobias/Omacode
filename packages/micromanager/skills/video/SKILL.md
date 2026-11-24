---
name: video
description: Build and check a short video with the video adapter (HyperFrames), including math animations made with Manim. Use when a task produces a video, an explainer clip, an animation for a website or a talk, or when a video has to pass its checks.
license: Apache-2.0
metadata:
  source: own
  verified_against: hyperframes 0.9.54 (render, check, lint, snapshot), manim 0.22.1, packages/artifact/src/adapters/video.ts
---

# Video

A video is data first: a `VideoSpec` (version 2) of scenes, each a few seconds long. The video adapter writes it as a
HyperFrames project, renders it to one file, and checks the file's frames and sound. Your job is the spec and the
material the scenes show (pictures, clips, Manim animations), not the HTML.

## What the spec says

A complete `video.json`; every field below except `audio` and `output` is required:

```json
{
  "kind": "video",
  "version": 2,
  "job": "pythagoras",
  "brief": "A 12-second explainer of the Pythagorean theorem for the project website",
  "engine": "hyperframes",
  "fps": 30,
  "size": { "width": 1280, "height": 720 },
  "scenes": [
    { "id": "intro", "title": "Pythagoras", "duration": 3, "captions": ["Why a² + b² = c²"] },
    { "id": "proof", "title": "The squares", "duration": 6, "asset": "clips/Squares.mp4", "captions": ["Rearrange the four triangles"] },
    { "id": "outro", "title": "That's it", "duration": 3, "captions": ["a² + b² = c²"] }
  ],
  "output": { "format": "mp4", "quality": "medium" }
}
```

- `scenes[]`: `id` (letters, digits, `.`, `_`, `-`; unique), `duration` in seconds (> 0), and optionally `title`,
  `captions` (lines shown on screen, in the pixels, not a subtitle track), `asset` (a picture or a clip, relative to
  the job directory: `.mp4`, `.webm`, `.mov` play muted in a loop, anything else is shown as an image) and
  `acceptance` (one line each: what the scene has to show, for the review).
- The film lasts exactly as long as the scenes together. A clip starts with its scene; one longer than its scene is
  cut, a shorter one holds its last frame until the scene ends. A clip plays muted (the film's sound is `audio`).
- `audio`: `{ "src": "music/bed.mp3", "volume": 0.6 }`, one bed under the whole film (0 to 1).
- `output.format`: `webm` (the default, no patent questions) or `mp4` (plays everywhere, also in Safari);
  `quality`: `low`, `medium` or `high`. The file is `video.webm` or `video.mp4` in the job directory.
- Every asset and the audio bed must exist before the build: a missing file is a refusal, not a placeholder.
- The render runs offline: system fonts only, nothing fetched.

Build with `make_artifact` (`spec: video.json`). The video needs HyperFrames and ffmpeg; if one is missing the tool says
so: offer `install_feature` for HyperFrames, and give the user the terminal command for ffmpeg (it needs sudo).

## Math animations with Manim

Manim makes the clip, the video adapter puts it in a scene. Render into the job directory, then name the file as the
scene's `asset`:

```bash
manim render -qm --media_dir media scenes.py Squares   # -ql while trying, -qh for the final
mkdir -p clips && cp media/videos/scenes/720p30/Squares.mp4 clips/
```

- `-ql` 480p15, `-qm` 720p30, `-qh` 1080p60: match the video's `size` and `fps` where you can.
- LaTeX is not installed: `Tex` and `MathTex` fail. Use `Text` (Unicode works: `Text("a² + b² = c²")`), shapes and
  `MathTex`-free animations, or tell the user LaTeX is needed (`sudo pacman -S texlive-core` or their distribution's
  equivalent) before you use it.
- Keep a Manim scene about as long as the video scene it fills: a longer clip is cut, a shorter one holds its last
  frame.
- Set the Manim background to the video's (`self.camera.background_color = "#101014"` in `construct`), so the clip
  does not sit in a black box.
- If `manim` is not found, offer `install_feature` with part `manim`.

## What the video must survive

- **count, duration** — every scene is in the project, and the file lasts as long as the scenes together.
- **lint, runtime** — the engine's lint finds no error, the page logs no console error.
- **snapshot** — one frame per scene, taken from its middle.
- **black, freeze, flash** — no run of black frames, no cut that shows the previous frame again, no frame much
  brighter than both neighbours (a flash).
- **silence** — skipped for a film without an audio bed (nothing to measure), checked with one.
- **transcript, vlm** — skipped: no local speech or vision model is configured, and a cloud model is not called for a
  check. Say so in the report; a skip is never a pass.

Fix the spec or the material when a check fails, never the check. Look at the snapshots before you call it done.

## A video on a website

Build the video first, then copy the file into the site and point at it (see the web skill):

```html
<video src="media/pythagoras.mp4" poster="media/pythagoras.jpg" controls preload="none" playsinline width="1280" height="720">
  A short explainer of the Pythagorean theorem.
</video>
```

`preload="none"` and a `poster` keep the page inside its weight budget (the browser loads the film only on play); use
`mp4` for a site, which every browser plays. A poster can be one of the video's snapshots.
