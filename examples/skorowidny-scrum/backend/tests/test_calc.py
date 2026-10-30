"""Decimal calculations with explicit rounding.

@author Skorowid
"""

import json
import os
import tempfile
import unittest
from decimal import Decimal

from skorowidny_scrum_example import DEFAULT_RULES, InvalidInputError, calculate, load_rules
from skorowidny_scrum_example.calc import validate_rule


def rule(**overrides):
    base = {"rule_id": "R", "version": 1, "operation": "sum", "quantum": "0.01", "rounding": "ROUND_HALF_EVEN"}
    base.update(overrides)
    return base


class CalcTest(unittest.TestCase):
    def setUp(self):
        self.rules = load_rules(DEFAULT_RULES)

    def test_sum_is_decimal_not_float(self):
        result = calculate(self.rules, "SAMPLE-SUM-HOURS", {"values": ["0.1", "0.2"]})
        self.assertEqual(result["result"], "0.30")
        self.assertEqual(result["unrounded"], "0.3")
        self.assertFalse(result["inexact"])
        self.assertEqual(result["warnings"], [])

    def test_rounding_mode_is_the_rule_s_not_a_default(self):
        half_even = calculate(self.rules, "SAMPLE-SUM-HOURS", {"values": ["0.125", "0.5"]})
        self.assertEqual(half_even["result"], "0.62")
        self.assertEqual(len(half_even["warnings"]), 1)
        half_up = {"R": rule(rounding="ROUND_HALF_UP")}
        self.assertEqual(calculate(half_up, "R", {"values": ["0.125", "0.5"]})["result"], "0.63")

    def test_percent_of(self):
        result = calculate(self.rules, "SAMPLE-PERCENT-DONE", {"part": 2, "whole": "3"})
        self.assertEqual(result["result"], "66.7")
        self.assertEqual(result["rule_version"], 1)
        self.assertEqual(result["inputs"], {"part": "2", "whole": "3"})
        self.assertEqual(calculate(self.rules, "SAMPLE-PERCENT-DONE", {"part": Decimal("0.05"), "whole": 1})["result"], "5.0")

    def test_negative_values_follow_rounding_mode(self):
        r = {"R": rule(rounding="ROUND_HALF_UP")}
        self.assertEqual(calculate(r, "R", {"values": ["-0.125"]})["result"], "-0.13")

    def test_invalid_inputs(self):
        cases = [
            ("SAMPLE-SUM-HOURS", {"values": [0.1]}),
            ("SAMPLE-SUM-HOURS", {"values": [True]}),
            ("SAMPLE-SUM-HOURS", {"values": ["abc"]}),
            ("SAMPLE-SUM-HOURS", {"values": ["NaN"]}),
            ("SAMPLE-SUM-HOURS", {"values": ["Infinity"]}),
            ("SAMPLE-SUM-HOURS", {"values": [None]}),
            ("SAMPLE-SUM-HOURS", {"values": []}),
            ("SAMPLE-SUM-HOURS", {"values": "1"}),
            ("SAMPLE-SUM-HOURS", {"values": ["1"], "extra": 1}),
            ("SAMPLE-SUM-HOURS", ["1"]),
            ("SAMPLE-PERCENT-DONE", {"part": "1", "whole": "0"}),
            ("SAMPLE-PERCENT-DONE", {"part": "1"}),
            ("UNKNOWN", {"values": ["1"]}),
        ]
        for rule_id, inputs in cases:
            with self.subTest(rule_id=rule_id, inputs=inputs):
                with self.assertRaises(InvalidInputError):
                    calculate(self.rules, rule_id, inputs)

    def test_invalid_rules(self):
        bad = [
            rule(rounding="nearest"),
            rule(operation="avg"),
            rule(quantum=0.01),
            rule(quantum="0.05"),
            rule(quantum="0"),
            rule(quantum="-0.01"),
            rule(version=0),
            rule(version=True),
            {k: v for k, v in rule().items() if k != "rounding"},
            rule(extra="x"),
        ]
        for i, r in enumerate(bad):
            with self.subTest(i=i):
                with self.assertRaises(InvalidInputError):
                    validate_rule(r)
        for quantum in ("1", "0.1", "0.001", "10"):
            validate_rule(rule(quantum=quantum))

    def test_rules_file_rejects_duplicates(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "rules.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"rules": [rule(), rule()]}, handle)
        with self.assertRaises(InvalidInputError):
            load_rules(path)


if __name__ == "__main__":
    unittest.main()
