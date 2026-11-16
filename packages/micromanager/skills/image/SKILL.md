---
name: image
description: Build and check an image set with the ComfyUI adapter. Use when a task needs pictures, illustrations or placeholders, or when an image set has to pass its checks before it is used.
license: Apache-2.0
metadata:
  source: own
  verified_against: ComfyUI 0.3.x with ComfyUI-GGUF, a Z-Image-Turbo int8 render on 2026-11-16
---

# Image

An image set is a spec first: slots with prompts, sizes and seeds, and a checkpoint per set or per slot. The adapter
writes one ComfyUI graph per slot, queues them one at a time because the GPU is one device, and collects the files into
the job. Your job is the prompts and the checkpoint choice, not the graph.

## The checkpoint is decided by its hash

A workflow can load any checkpoint on disk, so a name proves nothing. Before anything is generated the adapter hashes
the model file and asks the registry:

- a **blocklisted** hash is refused by name and reason;
- a **known** hash runs, but only where its licence permits the territory (EU by default);
- an **unknown** hash is refused with an offer to register it. `registerModel({ hash, name, license, territory })`
  writes the licence and territory that allow it from then on — never a silent allow.

So when a model is new to the machine, hash it, read its licence from the publisher, and register it. Do not rename a
file to look like something it is not: the hash is what is checked.

## Two kinds of checkpoint, two graphs

- **A full checkpoint** (one file) loads through `CheckpointLoaderSimple`; the set names that file and nothing else.
- **Split files** — a diffusion model plus a text encoder and a VAE, which is how most current models ship and how the
  GGUF quantizations work — need `UNETLoader`/`UnetLoaderGGUF`, `CLIPLoader` and `VAELoader`. Name the encoder and the
  VAE as the slot's first two `refs`, in that order; the adapter refuses a split slot whose refs are missing rather
  than guessing a file. A `.gguf` unet needs the ComfyUI-GGUF custom node, and the adapter says so by name when the
  server does not list it.

ComfyUI resolves a loader name in its own folders (`diffusion_models/`, `text_encoders/`, `vae/`), so the file names in
the spec are those, not a path on disk.

## Checks

- **count / files / size** — every slot produced a file at the size it asked for;
- **prompt** — the prompt's content words reach the workflow's positive text;
- **provenance** — the checkpoint's name, hash, licence and territory are on the record and the workflow still loads
  that checkpoint;
- **style** — the colours of the set are compared, in a deterministic way, not by taste;
- **placeholder** — a slot with no checkpoint at all gets a labelled checkerboard file instead of a refusal, and this
  check names it.

The vision review needs a local model; with none configured it is skipped with a reason (D13/D21), and the report says
so. A skipped check is an absence, never a pass.

## Cost

The first render of a model loads gigabytes onto the GPU: a 768×768 picture took about two minutes on the first call
and seconds after that. One slot at a time is deliberate — two renders at once would fight over the same device.
