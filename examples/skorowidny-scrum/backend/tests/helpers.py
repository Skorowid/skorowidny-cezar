"""Shared test helpers: a movable clock and fresh stores.

@author Skorowid
"""

import os
import tempfile
from datetime import datetime, timedelta, timezone

from skorowidny_scrum_example import BacklogStore, load_fixture

T0 = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now = self.now + timedelta(seconds=seconds)


def fixture_store(clock=None):
    """In-memory store loaded with the shipped synthetic fixture."""
    store = BacklogStore(":memory:", clock=clock or Clock())
    load_fixture(store)
    return store


def temp_db_path(testcase):
    """A file path in a temp dir removed after the test."""
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    return os.path.join(tmp.name, "backlog.sqlite3")


def ready_items(count, sprint_id="SPR-X"):
    """Synthetic fixture with ``count`` claimable items in one active sprint."""
    return {
        "sprints": [{"id": sprint_id, "goal": "synthetic", "status": "active"}],
        "documents": [],
        "work_items": [
            {
                "id": f"T-{i:03d}",
                "sprint_id": sprint_id,
                "sprint_order": i,
                "title": f"synthetic {i}",
                "dor_status": "READY",
                "approved": True,
                "version": 1,
            }
            for i in range(1, count + 1)
        ],
    }
