"""Fine-tune the decider's successor on the guards' training set (container plan P6-T3), on the GPU.

    uv run python train.py --rows ../data/guards.rows.jsonl --out runs/<name> [--epochs 4] [--eval-only]

The rows come from `npm run synth-guards -- --rows` (packages/micromanager/src/synth.ts): one row per case, one yes/no
classification per guard, each with the guard's instruction from the catalog as its prompt and a fixed train/held-out
split. The model is evaluated before and after training on the held-out rows the way the decider server asks it
(decider/server.py GlinerClassifier.probabilities: the guard as the task, yes and no with their descriptions, the
instruction), so the numbers say what the service will do. A guard says yes at P(yes) >= 0.5, the floor the plugin
uses (catalog.ts GUARD_FLOOR).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

FLOOR = 0.5
BASE = "hivetrace/gliner-guard-uniencoder"


def load(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return [r for r in rows if r.get("split") == "train"], [r for r in rows if r.get("split") == "heldout"]


def examples(rows: list[dict[str, Any]]) -> list[Any]:
    from gliner2.training.data import Classification, InputExample

    out = []
    for r in rows:
        classes = [
            Classification(task=c["task"], labels=list(c["labels"]), true_label=c["true_label"], prompt=c["prompt"], label_descriptions=dict(c["label_descriptions"]))
            for c in r["output"]["classifications"]
        ]
        out.append(InputExample(text=r["input"], classifications=classes))
    return out


def evaluate(extractor: Any, rows: list[dict[str, Any]], device: str) -> dict[str, dict[str, float]]:
    """Recall and false alarms per guard at the floor, and the mean latency per question."""
    from gliner2.classification import ClassificationSchema, Classifier

    clf = Classifier(extractor, device=device)
    counts: dict[str, dict[str, int]] = {}
    started = time.perf_counter()
    asked = 0
    for r in rows:
        for c in r["output"]["classifications"]:
            schema = ClassificationSchema.from_dict({"tasks": {c["task"]: {"labels": dict(c["label_descriptions"]), "min_labels": 1, "max_labels": 1, "instruction": c["prompt"]}}})
            probs = dict(clf.classify(r["input"], schema).probabilities(c["task"]))
            total = sum(probs.values()) or 1.0
            yes = probs.get("yes", 0.0) / total >= FLOOR
            truth = c["true_label"] == "yes"
            k = counts.setdefault(c["task"], {"tp": 0, "fn": 0, "fp": 0, "tn": 0})
            k["tp" if truth and yes else "fn" if truth else "fp" if yes else "tn"] += 1
            asked += 1
    seconds = time.perf_counter() - started
    out = {}
    for task, k in counts.items():
        pos, neg = k["tp"] + k["fn"], k["fp"] + k["tn"]
        out[task] = {"recall": k["tp"] / pos if pos else 0.0, "false_alarm": k["fp"] / neg if neg else 0.0, "positives": pos, "negatives": neg}
    out["_"] = {"ms_per_question": 1000 * seconds / max(asked, 1)}
    return out


def show(title: str, metrics: dict[str, dict[str, float]]) -> None:
    print(f"\n{title}")
    for task, m in metrics.items():
        if task == "_":
            print(f"  {m['ms_per_question']:.1f} ms per question")
        else:
            print(f"  {task:10s} recall {m['recall']:.2f} ({int(m['positives'])})   false alarm {m['false_alarm']:.2f} ({int(m['negatives'])})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--rows", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default=BASE)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--encoder-lr", type=float, default=1e-5)
    parser.add_argument("--task-lr", type=float, default=5e-4)
    parser.add_argument("--eval-only", action="store_true")
    args = parser.parse_args()

    import torch
    from gliner2 import AutoExtractor
    from gliner2.training.trainer import ExtractorTrainer, TrainingConfig

    device = "cuda" if torch.cuda.is_available() else "cpu"
    train_rows, held = load(args.rows)
    print(f"{len(train_rows)} training rows, {len(held)} held out, on {device}")
    extractor = AutoExtractor.from_pretrained(args.model)
    extractor.to(device)
    before = evaluate(extractor, held, device)
    show(f"before ({args.model})", before)
    report: dict[str, Any] = {"model": args.model, "rows": str(args.rows), "train": len(train_rows), "heldout": len(held), "before": before}
    if not args.eval_only:
        config = TrainingConfig(
            output_dir=str(args.out),
            experiment_name="guards",
            num_epochs=args.epochs,
            batch_size=args.batch,
            encoder_lr=args.encoder_lr,
            task_lr=args.task_lr,
            eval_strategy="epoch",
            save_best=True,
            num_workers=2,
            seed=42,
        )
        trainer = ExtractorTrainer(extractor, config, train_data=examples(train_rows), eval_data=examples(held))
        trainer.train()
        extractor.eval()
        after = evaluate(extractor, held, device)
        show("after", after)
        best = args.out / "final"
        extractor.save_pretrained(str(best))
        report.update({"after": after, "epochs": args.epochs, "saved": str(best)})
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
