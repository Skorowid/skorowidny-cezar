"""Claim policy, duplicates, expiry/recovery, invalid input and concurrency.

@author Skorowid
"""

import sqlite3
import threading
import unittest

from skorowidny_scrum_example import (
    BacklogStore,
    ClaimConflictError,
    ClaimExpiredError,
    ClaimNotFoundError,
    InvalidInputError,
    NotClaimableError,
    load_fixture_data,
)

from .helpers import Clock, fixture_store, ready_items, temp_db_path

TTL = 600


class ClaimPolicyTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.store = fixture_store(self.clock)
        self.addCleanup(self.store.close)

    def test_claim_next_takes_lowest_sprint_order_ready_item(self):
        claim = self.store.claim_next("SPR-1", "run-a", TTL)
        self.assertEqual(claim.task_id, "PBI-101")
        self.assertFalse(claim.reused)
        self.assertEqual(self.store.task_status("PBI-101"), "claimed")
        self.assertEqual(claim.expires_at, "2026-10-30T12:10:00.000000+00:00")

    def test_dependency_blocks_until_done(self):
        self.assertIn("dependency_not_done=PBI-101", self.store.explain("SPR-1")["PBI-102"])
        first = self.store.claim_next("SPR-1", "run-a", TTL)
        second = self.store.claim_next("SPR-1", "run-b", TTL)
        self.assertEqual(second.task_id, "PBI-106")  # PBI-102 skipped: dependency open
        self.store.complete(first.claim_id, "run-a")
        third = self.store.claim_next("SPR-1", "run-c", TTL)
        self.assertEqual(third.task_id, "PBI-102")

    def test_blocked_unapproved_and_other_dor_states_are_never_claimed(self):
        claimed = []
        for n in range(20):
            claim = self.store.claim_next("SPR-1", f"run-{n}", TTL)
            if claim is None:
                break
            claimed.append(claim.task_id)
            self.store.complete(claim.claim_id, f"run-{n}")
        self.assertEqual(claimed, ["PBI-101", "PBI-102", "PBI-106", "PBI-107", "PBI-108"])
        self.assertIsNone(self.store.claim_next("SPR-1", "run-late", TTL))

    def test_claim_task_reports_every_reason(self):
        cases = {
            "PBI-103": ["dor_status=BLOCKED"],
            "PBI-104": ["not_approved"],
            "PBI-105": ["dor_status=NEEDS CLARIFICATION", "not_approved"],
            "PBI-109": ["dor_status=CHANGE REQUEST", "not_approved"],
            "PBI-110": ["not_in_sprint"],
            "PBI-201": ["sprint_status=planned"],
        }
        for task_id, reasons in cases.items():
            with self.subTest(task_id=task_id):
                with self.assertRaises(NotClaimableError) as ctx:
                    self.store.claim_task(task_id, "run-x", TTL)
                self.assertEqual(ctx.exception.reasons, reasons)
                self.assertEqual(self.store.task_status(task_id), "open")

    def test_claim_next_in_planned_sprint_is_rejected(self):
        with self.assertRaises(NotClaimableError):
            self.store.claim_next("SPR-2", "run-a", TTL)

    def test_done_task_is_not_claimable_again(self):
        claim = self.store.claim_task("PBI-101", "run-a", TTL)
        self.store.complete(claim.claim_id, "run-a")
        with self.assertRaises(NotClaimableError) as ctx:
            self.store.claim_task("PBI-101", "run-b", TTL)
        self.assertEqual(ctx.exception.reasons, ["exec_status=done"])


class DuplicateClaimTest(unittest.TestCase):
    def setUp(self):
        self.store = fixture_store()
        self.addCleanup(self.store.close)

    def test_same_run_repeating_claim_next_gets_the_same_claim(self):
        first = self.store.claim_next("SPR-1", "run-a", TTL)
        again = self.store.claim_next("SPR-1", "run-a", TTL)
        self.assertTrue(again.reused)
        self.assertEqual(again.claim_id, first.claim_id)
        rows = self.store.connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
        self.assertEqual(rows, 1)

    def test_same_run_repeating_claim_task_is_idempotent(self):
        first = self.store.claim_task("PBI-101", "run-a", TTL)
        again = self.store.claim_task("PBI-101", "run-a", TTL)
        self.assertEqual(again.claim_id, first.claim_id)
        self.assertTrue(again.reused)

    def test_other_run_cannot_claim_held_task(self):
        self.store.claim_task("PBI-101", "run-a", TTL)
        with self.assertRaises(ClaimConflictError):
            self.store.claim_task("PBI-101", "run-b", TTL)

    def test_run_cannot_hold_two_tasks(self):
        self.store.claim_task("PBI-101", "run-a", TTL)
        with self.assertRaises(ClaimConflictError):
            self.store.claim_task("PBI-106", "run-a", TTL)
        self.assertEqual(self.store.task_status("PBI-106"), "open")

    def test_database_index_forbids_second_active_claim(self):
        self.store.claim_task("PBI-101", "run-a", TTL)
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.connection.execute(
                "INSERT INTO claims VALUES ('x', 'PBI-101', 'run-b', 't', 't', 'active', NULL)"
            )

    def test_other_run_cannot_complete_or_release(self):
        claim = self.store.claim_task("PBI-101", "run-a", TTL)
        with self.assertRaises(ClaimNotFoundError):
            self.store.complete(claim.claim_id, "run-b")
        with self.assertRaises(ClaimNotFoundError):
            self.store.release(claim.claim_id, "run-b")

    def test_release_reopens_and_second_completion_fails(self):
        claim = self.store.claim_task("PBI-101", "run-a", TTL)
        self.assertEqual(self.store.release(claim.claim_id, "run-a").status, "released")
        self.assertEqual(self.store.task_status("PBI-101"), "open")
        with self.assertRaises(ClaimNotFoundError):
            self.store.complete(claim.claim_id, "run-a")


class ExpiredClaimTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.store = fixture_store(self.clock)
        self.addCleanup(self.store.close)
        self.claim = self.store.claim_task("PBI-101", "run-a", TTL)

    def test_claim_is_active_until_exactly_expires_at(self):
        self.clock.advance(TTL - 1)
        self.assertEqual(self.store.expired_claims(), [])
        self.clock.advance(1)
        self.assertEqual([c.claim_id for c in self.store.expired_claims()], [self.claim.claim_id])

    def test_expired_claim_cannot_complete(self):
        self.clock.advance(TTL)
        with self.assertRaises(ClaimExpiredError):
            self.store.complete(self.claim.claim_id, "run-a")
        self.assertEqual(self.store.task_status("PBI-101"), "claimed")

    def test_expired_claim_is_not_taken_over_silently(self):
        self.clock.advance(TTL + 5)
        with self.assertRaises(ClaimExpiredError):
            self.store.claim_task("PBI-101", "run-b", TTL)
        with self.assertRaises(ClaimExpiredError):
            self.store.claim_next("SPR-1", "run-a", TTL)
        other = self.store.claim_next("SPR-1", "run-b", TTL)
        self.assertNotEqual(other.task_id, "PBI-101")

    def test_recovery_is_explicit_recorded_and_reopens_task(self):
        with self.assertRaises(ClaimConflictError):
            self.store.recover_expired("PBI-101", "too early")
        self.clock.advance(TTL)
        with self.assertRaises(InvalidInputError):
            self.store.recover_expired("PBI-101", "  ")
        recovered = self.store.recover_expired("PBI-101", "lost run; verify leftover branch")
        self.assertEqual(recovered.status, "recovered")
        self.assertEqual(recovered.note, "lost run; verify leftover branch")
        self.assertEqual(self.store.task_status("PBI-101"), "open")
        new = self.store.claim_task("PBI-101", "run-b", TTL)
        self.assertNotEqual(new.claim_id, self.claim.claim_id)
        with self.assertRaises(ClaimNotFoundError):
            self.store.recover_expired("PBI-103", "nothing to recover")


class InvalidInputTest(unittest.TestCase):
    def setUp(self):
        self.store = fixture_store()
        self.addCleanup(self.store.close)

    def test_bad_arguments(self):
        bad_calls = [
            lambda: self.store.claim_next("", "run", TTL),
            lambda: self.store.claim_next("SPR-1", "   ", TTL),
            lambda: self.store.claim_next("SPR-1", None, TTL),
            lambda: self.store.claim_next("SPR-1", "run", 0),
            lambda: self.store.claim_next("SPR-1", "run", -5),
            lambda: self.store.claim_next("SPR-1", "run", 1.5),
            lambda: self.store.claim_next("SPR-1", "run", True),
            lambda: self.store.claim_next("SPR-1", "run", "60"),
            lambda: self.store.claim_next("SPR-404", "run", TTL),
            lambda: self.store.claim_task(42, "run", TTL),
            lambda: self.store.explain("SPR-404"),
        ]
        for i, call in enumerate(bad_calls):
            with self.subTest(i=i):
                with self.assertRaises(InvalidInputError):
                    call()
        self.assertEqual(self.store.connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0], 0)

    def test_unknown_task(self):
        with self.assertRaises(ClaimNotFoundError):
            self.store.claim_task("PBI-999", "run", TTL)

    def test_naive_clock_is_rejected(self):
        from datetime import datetime

        store = BacklogStore(":memory:", clock=lambda: datetime(2026, 1, 1))
        self.addCleanup(store.close)
        load_fixture_data(store, ready_items(1))
        with self.assertRaises(InvalidInputError):
            store.claim_next("SPR-X", "run", TTL)


class ConcurrencyTest(unittest.TestCase):
    """Real threads, one connection each, one SQLite file."""

    THREADS = 12

    def _run_parallel(self, path, work):
        barrier = threading.Barrier(self.THREADS)
        results, errors = [None] * self.THREADS, []

        def worker(n):
            store = BacklogStore(path)
            try:
                barrier.wait(timeout=10)
                results[n] = work(store, n)
            except Exception as exc:  # collected and asserted below
                results[n] = exc
            finally:
                store.close()

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(self.THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
            self.assertFalse(t.is_alive(), "worker hung")
        return results

    def test_parallel_claim_next_never_double_claims(self):
        path = temp_db_path(self)
        with BacklogStore(path) as setup:
            load_fixture_data(setup, ready_items(5))
        results = self._run_parallel(path, lambda s, n: s.claim_next("SPR-X", f"run-{n}", TTL))
        unexpected = [r for r in results if isinstance(r, Exception)]
        self.assertEqual(unexpected, [])
        claimed = [r.task_id for r in results if r is not None]
        self.assertEqual(sorted(claimed), [f"T-{i:03d}" for i in range(1, 6)])
        self.assertEqual(results.count(None), self.THREADS - 5)
        with BacklogStore(path) as check:
            active = check.connection.execute("SELECT COUNT(*) FROM claims WHERE status='active'").fetchone()[0]
            self.assertEqual(active, 5)

    def test_parallel_claim_of_one_task_has_one_winner(self):
        path = temp_db_path(self)
        with BacklogStore(path) as setup:
            load_fixture_data(setup, ready_items(1))
        results = self._run_parallel(path, lambda s, n: s.claim_task("T-001", f"run-{n}", TTL))
        winners = [r for r in results if not isinstance(r, Exception)]
        losers = [r for r in results if isinstance(r, Exception)]
        self.assertEqual(len(winners), 1)
        self.assertTrue(all(isinstance(e, ClaimConflictError) for e in losers), losers)

    def test_parallel_retries_of_one_run_create_one_claim(self):
        path = temp_db_path(self)
        with BacklogStore(path) as setup:
            load_fixture_data(setup, ready_items(5))
        results = self._run_parallel(path, lambda s, n: s.claim_next("SPR-X", "same-run", TTL))
        self.assertTrue(all(not isinstance(r, Exception) for r in results), results)
        self.assertEqual(len({r.claim_id for r in results}), 1)
        self.assertEqual(sum(1 for r in results if not r.reused), 1)


if __name__ == "__main__":
    unittest.main()
