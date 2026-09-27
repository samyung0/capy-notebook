"""Scoring checks for the paired CPU replay, without model downloads."""

import unittest

from laya_cpu import metrics


class ScoringTests(unittest.TestCase):
    def test_point_errors_can_hide_behind_the_same_partial_award(self):
        pairs = [({"truth": [1, 0], "jev": [0.9, 0.1]}, {"scores": [0.1, 0.9]})]
        score = metrics(pairs, 0.5, "laya")
        self.assertEqual(score["award_accuracy"], 1)
        self.assertEqual(score["point_accuracy"], 0)
        self.assertEqual((score["met_missed"], score["unmet_credited"]), (1, 1))

    def test_failed_inference_is_not_a_zero_grade_or_a_missing_baseline(self):
        pairs = [({"truth": [0, 0], "jev": [0.1, 0.1]}, {"error": "OOM"})]
        laya, jev = (metrics(pairs, 0.5, source) for source in ("laya", "jev"))
        self.assertEqual((laya["failures"], laya["award_exact"]), (1, 0))
        self.assertEqual((jev["failures"], jev["award_exact"]), (0, 1))


if __name__ == "__main__":
    unittest.main()
