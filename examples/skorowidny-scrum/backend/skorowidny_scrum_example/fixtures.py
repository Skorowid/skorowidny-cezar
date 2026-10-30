"""Load synthetic JSON fixtures into a ``BacklogStore``.

The loader validates shape and enumerations and rejects unknown keys, so a
typo in a fixture fails loudly instead of silently changing the sample
policy. All shipped data is synthetic.

@author Skorowid
"""

import json
import sqlite3
from pathlib import Path

from .errors import InvalidInputError
from .store import DOC_STATUSES, DOR_STATUSES, EXEC_STATUSES, SPRINT_STATUSES

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures"
DEFAULT_FIXTURE = FIXTURE_DIR / "sample_backlog.json"
DEFAULT_RULES = FIXTURE_DIR / "sample_rules.json"

_TOP = {"_comment", "sprints", "work_items", "documents"}
_SPRINT = {"id", "goal", "status"}
_ITEM_REQUIRED = {"id", "title", "dor_status", "approved", "version"}
_ITEM = _ITEM_REQUIRED | {"sprint_id", "sprint_order", "exec_status", "acceptance", "depends_on", "doc_refs", "_comment"}
_DOC = {"doc_id", "version", "status", "title", "summary", "body"}


def _check_keys(kind, obj, allowed, required=None):
    if not isinstance(obj, dict):
        raise InvalidInputError(f"{kind} must be an object")
    required = allowed - {"_comment"} if required is None else required
    missing = required - obj.keys()
    unknown = obj.keys() - allowed
    if missing or unknown:
        raise InvalidInputError(f"{kind} {obj.get('id', obj.get('doc_id', '?'))}: missing={sorted(missing)} unknown={sorted(unknown)}")


def _positive_int(kind, value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise InvalidInputError(f"{kind} must be a positive int")


def load_fixture(store, path=DEFAULT_FIXTURE):
    """Insert the fixture at ``path`` into ``store`` in one transaction."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    load_fixture_data(store, data)


def load_fixture_data(store, data):
    """Validate and insert an already parsed fixture dict."""
    _check_keys("fixture", data, _TOP, required={"sprints", "work_items", "documents"})
    for sprint in data["sprints"]:
        _check_keys("sprint", sprint, _SPRINT)
        if sprint["status"] not in SPRINT_STATUSES:
            raise InvalidInputError(f"sprint {sprint['id']}: status {sprint['status']!r}")
    for doc in data["documents"]:
        _check_keys("document", doc, _DOC)
        _positive_int(f"document {doc['doc_id']} version", doc["version"])
        if doc["status"] not in DOC_STATUSES:
            raise InvalidInputError(f"document {doc['doc_id']}: status {doc['status']!r}")
    for item in data["work_items"]:
        _check_keys("work item", item, _ITEM, required=_ITEM_REQUIRED)
        if item["dor_status"] not in DOR_STATUSES:
            raise InvalidInputError(f"work item {item['id']}: dor_status {item['dor_status']!r}")
        if item.get("exec_status", "open") not in EXEC_STATUSES:
            raise InvalidInputError(f"work item {item['id']}: exec_status {item['exec_status']!r}")
        if not isinstance(item["approved"], bool):
            raise InvalidInputError(f"work item {item['id']}: approved must be true/false")
        _positive_int(f"work item {item['id']} version", item["version"])
        if item.get("sprint_id") is not None:
            _positive_int(f"work item {item['id']} sprint_order", item.get("sprint_order"))
        for ref in item.get("doc_refs", []):
            _check_keys(f"doc_ref of {item['id']}", ref, {"doc_id", "version"})
            _positive_int(f"doc_ref {ref['doc_id']} of {item['id']} version", ref["version"])

    try:
        _insert(store, data)
    except sqlite3.IntegrityError as exc:
        raise InvalidInputError(f"fixture violates a constraint: {exc}") from None


def _insert(store, data):
    with store.transaction() as conn:
        conn.executemany(
            "INSERT INTO sprints (id, goal, status) VALUES (:id, :goal, :status)", data["sprints"]
        )
        conn.executemany(
            "INSERT INTO documents (doc_id, version, status, title, summary, body)"
            " VALUES (:doc_id, :version, :status, :title, :summary, :body)",
            data["documents"],
        )
        for item in data["work_items"]:
            conn.execute(
                "INSERT INTO work_items (id, sprint_id, title, sprint_order, dor_status, approved,"
                " exec_status, version, acceptance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item["id"],
                    item.get("sprint_id"),
                    item["title"],
                    item.get("sprint_order"),
                    item["dor_status"],
                    int(item["approved"]),
                    item.get("exec_status", "open"),
                    item["version"],
                    json.dumps(item.get("acceptance", []), ensure_ascii=False),
                ),
            )
        for item in data["work_items"]:
            for dep in item.get("depends_on", []):
                conn.execute("INSERT INTO dependencies (task_id, depends_on) VALUES (?, ?)", (item["id"], dep))
            for ref in item.get("doc_refs", []):
                conn.execute(
                    "INSERT INTO task_doc_refs (task_id, doc_id, version) VALUES (?, ?, ?)",
                    (item["id"], ref["doc_id"], ref["version"]),
                )
