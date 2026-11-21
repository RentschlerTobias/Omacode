"""The decision server without torch: a fake classifier stands in for GLiNER2."""

import json
import threading
import unittest
import urllib.request
from collections.abc import Mapping
from http.server import ThreadingHTTPServer

from decider.server import YES_NO, Abandoned, decide, extract, make_handler, render_state


class FakeClassifier:
    """Scores the first label 0.8 unless a rule for the task says otherwise; records what it was asked."""

    def __init__(self, rules: Mapping[str, Mapping[str, float]] | None = None) -> None:
        self.rules = dict(rules or {})
        self.calls: list[tuple[str, str, dict[str, str], str]] = []

    def probabilities(self, text: str, task: str, labels: Mapping[str, str], instruction: str) -> dict[str, float]:
        self.calls.append((text, task, dict(labels), instruction))
        if task in self.rules:
            return dict(self.rules[task])
        names = list(labels)
        return {n: (0.8 if i == 0 else 0.2 / (len(names) - 1)) for i, n in enumerate(names)}


QUESTIONS = {
    "role": {"type": "choice", "instructions": "Which role (pick one) fits?", "criteria": {"code": "writes code", "explore": "reads [only]"}},
    "harmful": {"type": "noul", "instructions": "This task asks for help to hurt people."},
    "risk": {"type": "score", "instructions": "How risky?", "criteria": ["read only", "changes files", "irreversible"]},
}


class DecideTest(unittest.TestCase):
    def test_every_question_type_is_answered(self) -> None:
        fake = FakeClassifier({"harmful": {"yes": 1.0, "no": 3.0}, "risk": {"0": 0.2, "1": 0.6, "2": 0.2}})
        out = decide(fake, {"state": {"text": "Add a flag", "job": "j1"}, "questions": QUESTIONS}, "gliner")
        answers = out["answers"]
        self.assertEqual(answers["role"]["choice"], "code")
        self.assertAlmostEqual(answers["role"]["confidence"], 0.8)
        self.assertAlmostEqual(answers["harmful"]["noul"], 0.25)
        self.assertAlmostEqual(answers["risk"]["score"], 1.0)
        self.assertAlmostEqual(answers["risk"]["confidence"], 0.6)
        self.assertEqual(out["model"], "gliner")

    def test_markers_are_stripped_and_noul_uses_yes_no(self) -> None:
        fake = FakeClassifier()
        decide(fake, {"state": "plain text", "questions": QUESTIONS}, "gliner")
        role, harmful, _ = fake.calls
        self.assertEqual(role[2]["explore"], "reads only")
        self.assertEqual(role[3], "Which role , pick one fits?")
        self.assertEqual(harmful[2], YES_NO)
        self.assertEqual(role[0], "plain text")

    def test_unknown_or_empty_questions_are_left_unanswered(self) -> None:
        out = decide(FakeClassifier(), {"state": "x", "questions": {"a": {"type": "vote"}, "b": {"type": "choice", "criteria": {}}}}, "g")
        self.assertEqual(out["answers"], {})

    def test_a_gone_client_stops_the_work(self) -> None:
        fake = FakeClassifier()
        with self.assertRaises(Abandoned):
            decide(fake, {"state": "x", "questions": QUESTIONS}, "gliner", alive=lambda: False)
        self.assertEqual(fake.calls, [])

    def test_state_text_puts_the_task_first(self) -> None:
        self.assertEqual(render_state({"other": 1, "text": "hello"}), "text: hello\nother: 1")
        self.assertEqual(render_state('{"task": "t", "a": [1, 2]}'), "task: t\na: [1,2]")


class FakeFinder(FakeClassifier):
    """Finds every word of a fixed list as the first label; records the labels it was asked for."""

    def __init__(self, words: Mapping[str, str]) -> None:
        super().__init__()
        self.words = dict(words)
        self.asked: list[list[str]] = []

    def entities(self, text: str, labels: list[str], threshold: float) -> list[dict]:
        self.asked.append(labels)
        out = []
        for word, label in self.words.items():
            at = text.find(word)
            if at >= 0 and label in labels:
                out.append({"label": label, "text": word, "start": at, "end": at + len(word), "score": 0.9})
        return out


class EntitiesTest(unittest.TestCase):
    def test_spans_per_text_with_the_labels_as_asked(self) -> None:
        finder = FakeFinder({"Anna Weber": "person name", "Lindenstrasse 12": "street address , postal"})
        out = extract(finder, {"texts": ["Invoice to Anna Weber, Lindenstrasse 12.", "", "nothing here"], "labels": ["person name", "street address (postal)"]})
        self.assertEqual(finder.asked[0], ["person name", "street address , postal"])
        self.assertEqual(out["entities"][0][0], {"label": "person name", "text": "Anna Weber", "start": 11, "end": 21, "score": 0.9})
        self.assertEqual(out["entities"][0][1]["label"], "street address (postal)")
        self.assertEqual(out["entities"][1:], [[], []])

    def test_bad_bodies_are_refused(self) -> None:
        finder = FakeFinder({})
        for body in ({"texts": "x", "labels": ["a"]}, {"texts": ["x"], "labels": []}, {"texts": ["x"], "labels": ["a"], "threshold": 2}):
            with self.assertRaises(ValueError):
                extract(finder, body)


class HttpTest(unittest.TestCase):
    def test_the_wire_format_over_http(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(FakeClassifier(), "gliner"))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with urllib.request.urlopen(f"{base}/health") as r:
                self.assertEqual(json.load(r)["status"], "ok")
            req = urllib.request.Request(
                f"{base}/v1/systemone",
                data=json.dumps({"model": "gliner", "state": "{}", "questions": QUESTIONS}).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer local"},
            )
            with urllib.request.urlopen(req) as r:
                body = json.load(r)
            self.assertEqual(set(body["answers"]), {"role", "harmful", "risk"})
            bad = urllib.request.Request(f"{base}/v1/systemone", data=b"[1]", headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(bad)
            self.assertEqual(ctx.exception.code, 400)
            plain = urllib.request.Request(f"{base}/v1/entities", data=json.dumps({"texts": ["x"], "labels": ["a"]}).encode())
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(plain)
            self.assertEqual(ctx.exception.code, 501, "a classifier without entities says so")
        finally:
            server.shutdown()

    def test_a_token_guards_every_post_but_not_health(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(FakeClassifier(), "gliner", token="s3cret"))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        body = json.dumps({"model": "gliner", "state": "{}", "questions": QUESTIONS}).encode()
        try:
            with urllib.request.urlopen(f"{base}/health") as r:
                self.assertEqual(json.load(r)["status"], "ok")
            for header in ({}, {"Authorization": "Bearer local"}, {"Authorization": "s3cret"}):
                req = urllib.request.Request(f"{base}/v1/systemone", data=body, headers={"Content-Type": "application/json", **header})
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    urllib.request.urlopen(req)
                self.assertEqual(ctx.exception.code, 401, header)
            ok = urllib.request.Request(f"{base}/v1/systemone", data=body, headers={"Authorization": "Bearer s3cret"})
            with urllib.request.urlopen(ok) as r:
                self.assertEqual(set(json.load(r)["answers"]), {"role", "harmful", "risk"})
        finally:
            server.shutdown()

    def test_entities_over_http(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(FakeFinder({"Anna": "person name"}), "gliner"))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{server.server_address[1]}/v1/entities",
                data=json.dumps({"texts": ["hi Anna"], "labels": ["person name"], "threshold": 0.4}).encode(),
            )
            with urllib.request.urlopen(req) as r:
                self.assertEqual(json.load(r)["entities"], [[{"label": "person name", "text": "Anna", "start": 3, "end": 7, "score": 0.9}]])
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()


class CapTest(unittest.TestCase):
    """Eager attention is n²: a 24 000-character state cost 13.7 GB and 72 s for one decision (2026-11-18)."""

    def test_a_long_state_is_clamped_to_its_head(self) -> None:
        fake = FakeClassifier()
        out = decide(fake, {"state": {"text": "x" * 9000, "job": "j1"}, "questions": QUESTIONS}, "gliner")
        self.assertTrue(out["truncated"])
        self.assertLessEqual(len(fake.calls[0][0]), 4000, "the classifier never sees more than the cap")
        self.assertTrue(fake.calls[0][0].startswith("text: x"), "the task text is the part that is kept")

    def test_a_short_state_is_answered_without_a_note(self) -> None:
        fake = FakeClassifier()
        out = decide(fake, {"state": {"text": "Add a flag"}, "questions": QUESTIONS}, "gliner")
        self.assertNotIn("truncated", out)

    def test_the_cap_is_a_parameter(self) -> None:
        fake = FakeClassifier()
        out = decide(fake, {"state": {"text": "y" * 500}, "questions": QUESTIONS}, "gliner", max_chars=100)
        self.assertTrue(out["truncated"])
        self.assertLessEqual(len(fake.calls[0][0]), 100)

    def test_an_entity_text_is_bounded_by_its_own_limit(self) -> None:
        class FakeFinder:
            def entities(self, text, labels, threshold):
                return []

        self.assertNotIn("truncated", extract(FakeFinder(), {"texts": ["z" * 9000], "labels": ["person"], "threshold": 0.5}))
        out = extract(FakeFinder(), {"texts": ["z" * 9000], "labels": ["person"], "threshold": 0.5}, max_chars=5000)
        self.assertTrue(out["truncated"])


def test_entities_read_past_the_decision_clamp():
    """A name at character 10 000 is found: the entity endpoint reads in chunks, not the decision's first 2 000."""
    seen = []

    class Finder:
        def entities(self, text, labels, threshold):
            seen.append(len(text))
            at = text.find("Erika Mustermann")
            return [{"label": labels[0], "text": "Erika Mustermann", "start": at, "end": at + 16, "score": 0.9}] if at >= 0 else []

    text = "x " * 5000 + "Erika Mustermann wohnt hier."
    out = extract(Finder(), {"texts": [text], "labels": ["person name"]})
    assert out["entities"][0][0]["text"] == "Erika Mustermann"
    assert seen == [len(text)]
    assert "truncated" not in out
