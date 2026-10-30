"""Fixture validation, silent library imports and the demo driver.

@author Skorowid
"""

import contextlib
import copy
import io
import json
import os
import subprocess
import sys
import unittest

from skorowidny_scrum_example import BacklogStore, InvalidInputError, load_fixture_data
from skorowidny_scrum_example.demo import run_demo

from .helpers import ready_items

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class FixtureValidationTest(unittest.TestCase):
    def _load(self, data):
        store = BacklogStore(":memory:")
        self.addCleanup(store.close)
        load_fixture_data(store, data)
        return store

    def test_invalid_fixtures_are_rejected_and_nothing_is_written(self):
        def mutate(fn):
            data = copy.deepcopy(ready_items(2))
            fn(data)
            return data

        cases = {
            "unknown dor": mutate(lambda d: d["work_items"][0].update(dor_status="DONE")),
            "approved as string": mutate(lambda d: d["work_items"][0].update(approved="yes")),
            "typo key": mutate(lambda d: d["work_items"][0].update(aproved=True)),
            "missing order": mutate(lambda d: d["work_items"][0].pop("sprint_order")),
            "bad sprint status": mutate(lambda d: d["sprints"][0].update(status="running")),
            "unknown dependency": mutate(lambda d: d["work_items"][0].update(depends_on=["NOPE"])),
            "unknown sprint": mutate(lambda d: d["work_items"][0].update(sprint_id="SPR-404")),
            "duplicate id": mutate(lambda d: d["work_items"].append(dict(d["work_items"][0]))),
            "bad doc ref": mutate(lambda d: d["work_items"][0].update(doc_refs=[{"doc_id": "X"}])),
            "zero version": mutate(lambda d: d["work_items"][0].update(version=0)),
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                store = BacklogStore(":memory:")
                self.addCleanup(store.close)
                with self.assertRaises(InvalidInputError):
                    load_fixture_data(store, data)
                self.assertEqual(store.connection.execute("SELECT COUNT(*) FROM work_items").fetchone()[0], 0)

    def test_valid_synthetic_fixture_loads(self):
        store = self._load(ready_items(3))
        self.assertEqual(store.explain("SPR-X"), {"T-001": [], "T-002": [], "T-003": []})


class SilenceAndDemoTest(unittest.TestCase):
    def test_library_import_and_use_write_nothing_to_stdout(self):
        modules = ", ".join(f"skorowidny_scrum_example.{m}" for m in ("errors", "store", "context", "calc", "fixtures", "demo"))
        proc = subprocess.run(
            [sys.executable, "-c", f"import {modules}"], cwd=BACKEND_DIR, capture_output=True, text=True, timeout=60
        )
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (0, "", ""))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = run_demo()
        self.assertEqual(out.getvalue(), "")
        steps = {step["step"]: step["result"] for step in result["steps"]}
        self.assertEqual(steps["claim_next demo-run-1"]["task_id"], "PBI-101")
        self.assertTrue(steps["repeat claim_next demo-run-1"]["reused"])
        self.assertEqual(steps["recover_expired"]["status"], "recovered")
        self.assertEqual(steps["context PBI-106"]["error"], "StaleContextError")
        self.assertEqual(steps["calc sum"]["result"], "0.62")

    def test_demo_prints_json_only_when_run_explicitly(self):
        proc = subprocess.run(
            [sys.executable, "-m", "skorowidny_scrum_example.demo"],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        self.assertEqual(json.loads(proc.stdout)["now"], "2026-10-30T12:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
