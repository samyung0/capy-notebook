"""Focused checks for score validity and dataset/resume identity."""

import json
from pathlib import Path
import tempfile
import unittest

from benchmark import check_batch, digest, metrics, parse_output, read_cases, read_results, report
from analyse import load_complete, paired
from compare_runtimes import compare


class BenchmarkChecks(unittest.TestCase):
    def test_runtime_comparison_uses_only_shared_cases_and_rejects_changed_controls(self):
        cases = read_cases(Path(__file__).with_name("corpus.jsonl"))[:5]
        subset = cases[1:3]
        native_config = {"runtime": "llama.cpp-test", "settings": {"seed": 7, "parallel": 32},
                         "model_source": {"sha256": "weights"}, "prompt_sha256": "prompt"}
        browser_config = {"runtime": "wllama-test", "settings": {"seed": 7},
                          "model_source": {"sha256": "weights"}, "prompt_sha256": "prompt"}
        native = {case["id"]: dict(case, case_id=case["id"], config=native_config, batch="native",
                                    score=case["expected"], valid_score=True, valid_output=True,
                                    strict_json=True, seconds=1) for case in cases}
        browser = {case["id"]: dict(native[case["id"]], config=browser_config, batch="browser",
                                     score=0, valid_score=True) for case in subset}
        browser[subset[1]["id"]].update(score=None, valid_score=False, valid_output=False)
        result = compare(cases, subset, {"a": native}, {"a": browser})["models"]["a"]
        self.assertEqual(result["native_complete_cases"], 5)
        self.assertEqual(result["shared_cases"], 2)
        self.assertEqual(result["groups"]["primary"]["native"]["agreement"], 1)
        self.assertEqual(result["groups"]["primary"]["browser"]["agreement"], 0)
        self.assertEqual(result["groups"]["primary"]["browser_minus_native"]["accuracy_difference"], -1)
        with self.assertRaisesRegex(ValueError, "not an identical native case"):
            compare(cases, [dict(subset[0], case_sha256="changed")], {"a": native}, {"a": browser})
        browser_config["settings"]["seed"] = 8
        with self.assertRaisesRegex(ValueError, "decoding settings differ"):
            compare(cases, subset, {"a": native}, {"a": browser})
        browser_config["settings"]["seed"] = 7
        browser_config["model_source"]["sha256"] = "changed"
        with self.assertRaisesRegex(ValueError, "model hashes differ"):
            compare(cases, subset, {"a": native}, {"a": browser})
        browser_config["model_source"]["sha256"] = "weights"
        for prompt_hash in ("different-system-prompt", None):
            browser_config["prompt_sha256"] = prompt_hash
            with self.assertRaisesRegex(ValueError, "Prompt-source hashes"):
                compare(cases, subset, {"a": native}, {"a": browser})

    def test_comparison_requires_complete_data_and_valid_paired_scores(self):
        cases = read_cases(Path(__file__).with_name("corpus.jsonl"))[:2]
        rows = [dict(case, case_id=case["id"], config={"model": "a"}, batch="batch",
                     score=None, valid_score=False) for case in cases]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results.jsonl"
            path.write_text(json.dumps(rows[0]) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Incomplete a"):
                load_complete([path], cases, ["a"])
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            self.assertEqual(len(load_complete([path], cases, ["a"])["a"]), 2)
            rows[1]["challenge"] = "mixed_language"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "challenge/language metadata mismatch"):
                load_complete([path], cases, ["a"])
            rows[1].pop("challenge")
            rows[1]["case_sha256"] = "different"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Dataset mismatch"):
                load_complete([path], cases, ["a"])
        comparison = paired(rows, rows, lambda row: row["case_id"])
        self.assertEqual(comparison["accuracy_difference"], 0)
        self.assertEqual(comparison["family_bootstrap_95"], [0, 0])
        self.assertEqual(comparison["same_valid_score"], 0)
        self.assertIsNone(comparison["valid_score_consistency_when_both_valid"])

    def test_resume_rejects_expanded_dataset_in_same_output(self):
        configuration = {"model": "example"}
        previous = [{"config": configuration, "batch": "original-subset"}]
        check_batch(previous, configuration, "original-subset")
        check_batch(previous, {"model": "different"}, "different-batch")
        with self.assertRaisesRegex(ValueError, "separate output file"):
            check_batch(previous, configuration, "expanded-dataset")

    def test_invalid_output_never_becomes_zero(self):
        for raw in ['nothing', '{"score":null}', '{"score":true}', '{"score":"0"}',
                    '{"score":0.7}', '{"score":NaN}', '[]']:
            parsed = parse_output(raw)
            self.assertFalse(parsed["valid_score"], raw)
            self.assertIsNone(parsed["score"], raw)
        valid = parse_output('{"score":0,"reason":"Neither criterion is met."}')
        self.assertTrue(valid["valid_output"])
        self.assertEqual(valid["score"], 0)
        self.assertFalse(parse_output('{"score":1}')["valid_output"])

    def test_pilot_and_family_split_integrity(self):
        path = Path(__file__).with_name("pilot.jsonl")
        cases = read_cases(path)
        self.assertEqual(len(cases), 70)
        self.assertEqual(len({c["language"] for c in cases}), 7)
        question = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
        other = dict(question, id="different-id", split="test")
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / "bad.jsonl"
            bad.write_text(json.dumps(question) + "\n" + json.dumps(other), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "Family split leakage"):
                read_cases(bad)
        self.assertNotEqual(digest({"context": 1024}), digest({"context": 2048}))

    def test_interrupted_resume_and_separate_configurations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.jsonl"
            row = {"config": {"model": "example", "context": 1024}, "case_id": "a",
                   "case_sha256": "original", "family": "f", "language": "en", "domain": "math",
                   "answer_kind": "partial_a", "expected": 0.5, "score": 0.5, "valid_score": True,
                   "valid_output": True, "strict_json": True, "seconds": 1, "label_source": "codex-authored"}
            second = dict(row, config={"model": "example", "context": 2048}, score=1)
            path.write_bytes((json.dumps(row) + "\n" + json.dumps(second) + '\n{"broken":').encode())
            self.assertEqual(len(read_results(path, repair_tail=True)), 2)
            self.assertTrue(list(path.parent.glob("*.interrupted-*")))
            report(path)
            results = json.loads(path.with_suffix(".summary.json").read_text())
            overall = [r for r in results if r["language"] == r["domain"] == r["answer_kind"] == "all"]
            self.assertEqual(len(overall), 2)
            self.assertEqual(sorted(r["agreement"] for r in overall), [0, 1])
            stats = metrics([row, second, dict(row, valid_score=False, valid_output=False, score=None)])
            self.assertAlmostEqual(stats["agreement"], 1 / 3)
            self.assertEqual(stats["majority_baseline"], 1)
            self.assertEqual(stats["invalid_outputs"], 1)

    def test_primary_reports_exclude_anchors_and_ambiguous_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.jsonl"
            base = {"config": {"model": "example"}, "case_sha256": "case", "family": "f",
                    "language": "en", "domain": "math", "expected": 0.5, "score": 0.5,
                    "valid_score": True, "valid_output": True, "seconds": 1,
                    "label_source": "codex-reviewed", "answer_kind": "partial_a",
                    "matched_across_languages": True, "source_kind": "original"}
            variants = [dict(base, case_id="matched-en"),
                        dict(base, case_id="matched-es", language="es", source_kind="matched_translation"),
                        dict(base, case_id="ambiguous", label_ambiguous=True),
                        dict(base, case_id="anchor", answer_kind="reference_anchor"),
                        dict(base, case_id="native", source_kind="native", matched_across_languages=False)]
            path.write_text("".join(json.dumps(row) + "\n" for row in variants), encoding="utf-8")
            report(path)
            overall = {row["answer_kind"]: row["cases"]
                       for row in json.loads(path.with_suffix(".summary.json").read_text())
                       if row["language"] == row["domain"] == "all"}
            self.assertEqual(overall["all"], 5)
            self.assertEqual(overall["primary"], 3)
            self.assertEqual(overall["primary_matched"], 2)
            self.assertEqual(overall["primary_native"], 1)


if __name__ == "__main__":
    unittest.main()
