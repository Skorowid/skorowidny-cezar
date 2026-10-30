"""Regression tests for the four review findings on the example (task 4914edaf).

Nine tests fail before the fixes; two guard tests pin unchanged behaviour.

@author Skorowid
"""

import unittest

from skorowidny_scrum_example import (
    DEFAULT_RULES,
    BacklogStore,
    ClaimConflictError,
    InvalidInputError,
    StaleContextError,
    build_context,
    calculate,
    load_fixture_data,
    load_rules,
    verify_context,
)

from .helpers import Clock, fixture_store

TTL = 600


def two_active_sprints():
    """Synthetic fixture: one claimable item in each of two active sprints."""
    return {
        "sprints": [
            {"id": "SPR-X", "goal": "synthetic x", "status": "active"},
            {"id": "SPR-Y", "goal": "synthetic y", "status": "active"},
        ],
        "documents": [],
        "work_items": [
            {"id": "X-1", "sprint_id": "SPR-X", "sprint_order": 1, "title": "x", "dor_status": "READY", "approved": True, "version": 1},
            {"id": "Y-1", "sprint_id": "SPR-Y", "sprint_order": 1, "title": "y", "dor_status": "READY", "approved": True, "version": 1},
        ],
    }


class ExplainInactiveSprintTest(unittest.TestCase):
    """Finding 1: ``[]`` from ``explain`` must mean claimable."""

    def setUp(self):
        self.store = fixture_store()
        self.addCleanup(self.store.close)

    def test_explain_reports_inactive_sprint(self):
        self.assertEqual(self.store.explain("SPR-2"), {"PBI-201": ["sprint_status=planned"]})

    def test_explain_of_active_sprint_is_unchanged(self):
        self.assertEqual(self.store.explain("SPR-1")["PBI-101"], [])


class CrossSprintRetryTest(unittest.TestCase):
    """Finding 2: a run's existing claim is reused only within its own Sprint."""

    def setUp(self):
        self.store = BacklogStore(":memory:", clock=Clock())
        self.addCleanup(self.store.close)
        load_fixture_data(self.store, two_active_sprints())

    def test_claim_next_in_other_sprint_conflicts(self):
        first = self.store.claim_next("SPR-X", "run-a", TTL)
        self.assertEqual(first.task_id, "X-1")
        with self.assertRaises(ClaimConflictError):
            self.store.claim_next("SPR-Y", "run-a", TTL)
        self.assertEqual(self.store.task_status("Y-1"), "open")
        rows = self.store.connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
        self.assertEqual(rows, 1)

    def test_same_sprint_retry_stays_idempotent(self):
        first = self.store.claim_next("SPR-X", "run-a", TTL)
        again = self.store.claim_next("SPR-X", "run-a", TTL)
        self.assertTrue(again.reused)
        self.assertEqual(again.claim_id, first.claim_id)


class VerifyContextIntegrityTest(unittest.TestCase):
    """Finding 3: the supplied payload must match its own key and the store."""

    def setUp(self):
        self.store = fixture_store()
        self.addCleanup(self.store.close)

    def test_changed_payload_with_original_key_is_rejected(self):
        ctx = build_context(self.store, "PBI-101")
        ctx["task"]["title"] = "edited by the caller"
        with self.assertRaises(InvalidInputError):
            verify_context(self.store, ctx)

    def test_malformed_packages_raise_invalid_input(self):
        good = build_context(self.store, "PBI-101")
        cases = [
            None,
            [],
            {"context_key": good["context_key"], "task": "PBI-101"},
            {"context_key": good["context_key"], "task": {}},
            {"context_key": good["context_key"], "task": {"id": 101}},
            {"context_key": 7, "task": {"id": "PBI-101"}},
            dict(good, extra={1, 2}),
        ]
        for i, package in enumerate(cases):
            with self.subTest(i=i):
                with self.assertRaises(InvalidInputError):
                    verify_context(self.store, package)

    def test_body_edit_at_same_version_is_detected_without_body_text(self):
        ctx = build_context(self.store, "PBI-101")
        for doc in ctx["documents"]:
            self.assertNotIn("body", doc)
            self.assertEqual(len(doc["body_sha256"]), 64)
        self.store.connection.execute(
            "UPDATE documents SET body = 'silently edited' WHERE doc_id = 'REQ-001' AND version = 2"
        )
        with self.assertRaises(StaleContextError):
            verify_context(self.store, ctx)


class DecimalPrecisionTest(unittest.TestCase):
    """Finding 4: no exactness claim; intermediate precision loss is flagged."""

    def setUp(self):
        self.rules = load_rules(DEFAULT_RULES)

    def test_two_thirds_is_flagged_inexact(self):
        result = calculate(self.rules, "SAMPLE-PERCENT-DONE", {"part": "2", "whole": "3"})
        self.assertNotIn("exact", result)
        self.assertTrue(result["inexact"])
        self.assertEqual(result["precision"], 50)
        self.assertTrue(any("precision" in w for w in result["warnings"]), result["warnings"])
        self.assertEqual(result["result"], "66.7")

    def test_representable_sum_is_not_flagged(self):
        result = calculate(self.rules, "SAMPLE-SUM-HOURS", {"values": ["0.1", "0.2"]})
        self.assertFalse(result["inexact"])
        self.assertEqual(result["unrounded"], "0.3")

    def test_long_operand_is_flagged_inexact(self):
        result = calculate(self.rules, "SAMPLE-SUM-HOURS", {"values": ["0." + "1" * 60]})
        self.assertTrue(result["inexact"])
        self.assertEqual(result["result"], "0.11")

    def test_unrepresentable_extremes_raise_invalid_input(self):
        cases = [
            ("SAMPLE-SUM-HOURS", {"values": ["1e60"]}),
            ("SAMPLE-SUM-HOURS", {"values": ["9e999999", "9e999999"]}),
            ("SAMPLE-PERCENT-DONE", {"part": "1e999999", "whole": "1e-999999"}),
        ]
        for rule_id, inputs in cases:
            with self.subTest(inputs=inputs):
                with self.assertRaises(InvalidInputError):
                    calculate(self.rules, rule_id, inputs)


if __name__ == "__main__":
    unittest.main()
