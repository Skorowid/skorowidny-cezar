"""Compact context: explicit versions, missing/unapproved/stale references.

@author Skorowid
"""

import unittest

from skorowidny_scrum_example import (
    InvalidInputError,
    MissingContextError,
    StaleContextError,
    UnapprovedContextError,
    build_context,
    get_document,
    verify_context,
)

from .helpers import fixture_store


class ContextTest(unittest.TestCase):
    def setUp(self):
        self.store = fixture_store()
        self.addCleanup(self.store.close)

    def test_context_carries_explicit_versions_and_omits_bodies(self):
        ctx = build_context(self.store, "PBI-101")
        self.assertEqual(ctx["task"]["id"], "PBI-101")
        self.assertEqual(ctx["task"]["version"], 3)
        self.assertEqual(ctx["sprint"]["id"], "SPR-1")
        self.assertEqual(
            [(d["doc_id"], d["version"], d["status"]) for d in ctx["documents"]],
            [("DEC-001", 1, "approved"), ("REQ-001", 2, "approved")],
        )
        self.assertTrue(all("body" not in d for d in ctx["documents"]))
        self.assertEqual(ctx["omitted"], ["documents.body"])
        self.assertEqual(len(ctx["context_key"]), 64)

    def test_context_is_deterministic(self):
        self.assertEqual(build_context(self.store, "PBI-101"), build_context(self.store, "PBI-101"))

    def test_full_document_is_available_by_explicit_version(self):
        self.assertIn("Columns", get_document(self.store, "REQ-001", 2)["body"])
        with self.assertRaises(MissingContextError):
            get_document(self.store, "REQ-001", 9)
        with self.assertRaises(InvalidInputError):
            get_document(self.store, "REQ-001", "2")

    def test_dependencies_are_listed_with_status(self):
        ctx = build_context(self.store, "PBI-102")
        self.assertEqual(ctx["dependencies"], [{"id": "PBI-101", "exec_status": "open"}])

    def test_missing_unapproved_and_stale_references_fail(self):
        with self.assertRaises(StaleContextError):
            build_context(self.store, "PBI-106")
        with self.assertRaises(UnapprovedContextError):
            build_context(self.store, "PBI-107")
        with self.assertRaises(MissingContextError):
            build_context(self.store, "PBI-108")
        with self.assertRaises(MissingContextError):
            build_context(self.store, "PBI-999")
        with self.assertRaises(InvalidInputError):
            build_context(self.store, "")

    def test_task_without_sprint_or_docs_has_empty_sections(self):
        ctx = build_context(self.store, "PBI-110")
        self.assertIsNone(ctx["sprint"])
        self.assertEqual(ctx["documents"], [])

    def test_new_approved_version_makes_built_context_stale(self):
        ctx = build_context(self.store, "PBI-101")
        self.assertEqual(verify_context(self.store, ctx)["context_key"], ctx["context_key"])
        self.store.connection.execute(
            "INSERT INTO documents VALUES ('REQ-001', 3, 'approved', 't', 's', 'b')"
        )
        with self.assertRaises(StaleContextError):
            verify_context(self.store, ctx)

    def test_task_edit_makes_built_context_stale(self):
        ctx = build_context(self.store, "PBI-101")
        self.store.connection.execute("UPDATE work_items SET version = 4 WHERE id = 'PBI-101'")
        with self.assertRaises(StaleContextError):
            verify_context(self.store, ctx)

    def test_verify_rejects_foreign_input(self):
        with self.assertRaises(InvalidInputError):
            verify_context(self.store, {"task": {"id": "PBI-101"}})


if __name__ == "__main__":
    unittest.main()
