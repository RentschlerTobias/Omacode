"""Separate or joint: do the guards answer the same when asked in one forward pass?

    uv run python joint_eval.py --model ../models/<checkpoint> --rows ../data/guards.rows.jsonl [--entities]

The decider asks every guard in a pass of its own (decider/server.py GlinerClassifier.probabilities). GLiNER2 can ask
several classifications, and entity labels, in one pass (`create_schema()` + `extract`), which saves the encoder runs
the questions share: 20-30 % of the decider's time. But all questions are put in front of the text, so they influence
each other, and a checkpoint chosen on one question per pass need not answer the same in a joint one.

This runs the held-out guard rows both ways and prints, per guard, recall and false alarms at P(yes) >= 0.5 for
"separate" (today) and "joint" (all guards, plus "person name"/"street address" with --entities), how many decisions
flip between the two, and the milliseconds per case. A joint pass replaces the separate ones only when its recall is
at least as high and its false alarms at most as high, guard by guard (roadmap 1.1, D26).

First measurement, 2026-11-25 (guard-2026-11-21, 352 held-out cases, CPU, 4 threads), recall / false alarms:
    separate                      injection 0.895 / 0.7 %   sensitive 0.867 / 1.9 %   ~185 ms
    joint, the two guards         injection 0.868 / 0.4 %   sensitive 0.867 / 2.8 %   ~147 ms
    joint, guards + entities      injection 0.895 / 0.4 %   sensitive 0.867 / 4.3 %   ~159 ms
    joint, as trained (+harmful)  injection 0.882 / 0.7 %   sensitive 0.833 / 1.2 %
The checkpoint had been trained with several guards per row, in shuffled order, but chosen on one question per pass.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

FLOOR = 0.5
ENTITY_LABELS = ["person name", "street address"]


def heldout(rows_path: Path, guards: list[str]) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in rows_path.read_text().splitlines() if line.strip()]
    rows = [r for r in rows if r.get("split") == "heldout" and "classifications" in r["output"]]
    return [r for r in rows if {c["task"] for c in r["output"]["classifications"]} >= set(guards)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", required=True, help="a checkpoint directory or a model id")
    parser.add_argument("--rows", required=True, type=Path, help="guard rows from `npm run synth-guards -- --rows`")
    parser.add_argument("--guards", default="injection,sensitive", help="the guards the decider asks (comma-separated)")
    parser.add_argument("--entities", action="store_true", help="ask the entity labels in the joint pass too")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    import torch
    from gliner2 import AutoExtractor
    from gliner2.classification import ClassificationSchema, Classifier

    torch.set_num_threads(args.threads)
    extractor = AutoExtractor.from_pretrained(args.model)
    extractor.to("cpu")
    classifier = Classifier(extractor, device="cpu")
    guards = [g.strip() for g in args.guards.split(",") if g.strip()]
    rows = heldout(args.rows, guards)

    def asked(row: dict[str, Any]) -> list[dict[str, Any]]:
        return [c for c in row["output"]["classifications"] if c["task"] in guards]

    def separate(row: dict[str, Any]) -> dict[str, float]:
        out = {}
        for c in asked(row):
            schema = ClassificationSchema.from_dict(
                {"tasks": {c["task"]: {"labels": c["label_descriptions"], "min_labels": 1, "max_labels": 1, "instruction": c["prompt"]}}}
            )
            out[c["task"]] = classifier.classify(row["input"], schema).probabilities(c["task"])["yes"]
        return out

    def joint(row: dict[str, Any]) -> dict[str, float]:
        schema = extractor.create_schema()
        for c in asked(row):
            schema = schema.classification(c["task"], c["label_descriptions"], prompt=c["prompt"])
        if args.entities:
            schema = schema.entities(ENTITY_LABELS, threshold=FLOOR)
        result = extractor.extract(row["input"], schema, include_confidence=True)
        return {g: result[g]["confidence"] if result[g]["label"] == "yes" else 1 - result[g]["confidence"] for g in guards}

    counts = {way: {g: {"tp": 0, "fn": 0, "fp": 0, "tn": 0} for g in guards} for way in ("separate", "joint")}
    flips = {g: 0 for g in guards}
    seconds = {"separate": 0.0, "joint": 0.0}
    separate(rows[0])  # load and warm up outside the clock
    for row in rows:
        truth = {c["task"]: c["true_label"] == "yes" for c in asked(row)}
        answers = {}
        for way, ask in (("separate", separate), ("joint", joint)):
            t0 = time.perf_counter()
            answers[way] = ask(row)
            seconds[way] += time.perf_counter() - t0
        for g in guards:
            if (answers["separate"][g] >= FLOOR) != (answers["joint"][g] >= FLOOR):
                flips[g] += 1
            for way in counts:
                said = answers[way][g] >= FLOOR
                counts[way][g]["tp" if truth[g] and said else "fn" if truth[g] else "fp" if said else "tn"] += 1

    print(f"{len(rows)} held-out cases, joint pass: {', '.join(guards)}{' + entities' if args.entities else ''}")
    for way in counts:
        cells = []
        for g in guards:
            c = counts[way][g]
            recall = c["tp"] / max(1, c["tp"] + c["fn"])
            false_alarms = c["fp"] / max(1, c["fp"] + c["tn"])
            cells.append(f"{g} {recall:.3f} / {false_alarms * 100:.1f} %")
        print(f"{way:9s} {'   '.join(cells)}   {seconds[way] * 1000 / len(rows):.0f} ms per case")
    print("decisions flipped: " + ", ".join(f"{g} {n}" for g, n in flips.items()))


if __name__ == "__main__":
    main()
