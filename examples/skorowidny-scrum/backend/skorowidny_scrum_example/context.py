"""Compact per-task context with explicit document versions.

Sample context policy (README.md, NOT approved product behaviour):

* A task references documents as explicit ``(doc_id, version)`` pairs; the
  builder never substitutes "latest".
* A referenced version must exist (else ``MissingContextError``), be
  ``approved`` (else ``UnapprovedContextError``) and still be the newest
  approved version of that document (else ``StaleContextError``).
* The package carries summaries, not bodies; ``omitted`` says what was left
  out and ``get_document`` returns the full text on demand. Each document
  carries ``body_sha256`` so an edit of the body at the same version is
  detected without shipping the text.
* ``context_key`` hashes everything the package was built from.
  ``verify_context`` checks that the supplied payload still matches its own
  key (else ``InvalidInputError``) and that a fresh build matches it (else
  ``StaleContextError``).

@author Skorowid
"""

import hashlib
import json

from .errors import (
    InvalidInputError,
    MissingContextError,
    StaleContextError,
    UnapprovedContextError,
)

GENERATOR_VERSION = "example-context/2"


def _task_row(conn, task_id):
    if not isinstance(task_id, str) or not task_id.strip():
        raise InvalidInputError("task_id must be a non-empty string")
    row = conn.execute("SELECT * FROM work_items WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise MissingContextError(f"unknown task {task_id}")
    return row


def build_context(store, task_id):
    """Return the compact context dict for ``task_id`` or raise a ContextError."""
    conn = store.connection
    task = _task_row(conn, task_id)
    sprint = None
    if task["sprint_id"] is not None:
        sprint = conn.execute("SELECT * FROM sprints WHERE id = ?", (task["sprint_id"],)).fetchone()
        if sprint is None:
            raise MissingContextError(f"task {task_id} references unknown sprint {task['sprint_id']}")

    refs = conn.execute(
        "SELECT doc_id, version FROM task_doc_refs WHERE task_id = ? ORDER BY doc_id", (task_id,)
    ).fetchall()
    documents = []
    for ref in refs:
        doc = conn.execute(
            "SELECT doc_id, version, status, title, summary, body FROM documents WHERE doc_id = ? AND version = ?",
            (ref["doc_id"], ref["version"]),
        ).fetchone()
        if doc is None:
            raise MissingContextError(f"task {task_id} references missing {ref['doc_id']} v{ref['version']}")
        if doc["status"] != "approved":
            raise UnapprovedContextError(
                f"task {task_id} references {ref['doc_id']} v{ref['version']} with status {doc['status']}"
            )
        latest = conn.execute(
            "SELECT MAX(version) AS v FROM documents WHERE doc_id = ? AND status = 'approved'",
            (ref["doc_id"],),
        ).fetchone()["v"]
        if latest != ref["version"]:
            raise StaleContextError(
                f"task {task_id} references {ref['doc_id']} v{ref['version']}; latest approved is v{latest}"
            )
        entry = {key: doc[key] for key in ("doc_id", "version", "status", "title", "summary")}
        entry["body_sha256"] = hashlib.sha256(doc["body"].encode("utf-8")).hexdigest()
        documents.append(entry)

    deps = conn.execute(
        "SELECT d.depends_on AS id, w.exec_status FROM dependencies d"
        " JOIN work_items w ON w.id = d.depends_on WHERE d.task_id = ? ORDER BY d.depends_on",
        (task_id,),
    ).fetchall()

    package = {
        "generator": GENERATOR_VERSION,
        "task": {
            "id": task["id"],
            "version": task["version"],
            "title": task["title"],
            "dor_status": task["dor_status"],
            "approved": bool(task["approved"]),
            "acceptance": json.loads(task["acceptance"]),
        },
        "sprint": None if sprint is None else {"id": sprint["id"], "goal": sprint["goal"], "status": sprint["status"]},
        "dependencies": [dict(dep) for dep in deps],
        "documents": documents,
        "omitted": ["documents.body"],
    }
    package["context_key"] = _context_key(package)
    return package


def _context_key(package):
    material = {key: value for key, value in package.items() if key != "context_key"}
    canonical = json.dumps(material, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def verify_context(store, package):
    """Check a previously built package against itself and the store.

    ``InvalidInputError``: not a ``build_context`` package, or its payload no
    longer matches its own ``context_key``. ``StaleContextError``: the store
    changed since the build. Errors from the rebuild itself (missing,
    unapproved, stale reference) propagate unchanged. Returns the fresh
    package on success.
    """
    task = package.get("task") if isinstance(package, dict) else None
    task_id = task.get("id") if isinstance(task, dict) else None
    supplied_key = package.get("context_key") if isinstance(package, dict) else None
    if not isinstance(task_id, str) or not task_id.strip() or not isinstance(supplied_key, str):
        raise InvalidInputError("package must be a dict produced by build_context")
    try:
        payload_key = _context_key(package)
    except (TypeError, ValueError):
        raise InvalidInputError("package payload is not JSON-serialisable") from None
    if payload_key != supplied_key:
        raise InvalidInputError(f"package payload for task {task_id} does not match its context_key")
    fresh = build_context(store, task_id)
    if fresh["context_key"] != supplied_key:
        raise StaleContextError(f"context for task {task_id} changed since it was built")
    return fresh


def get_document(store, doc_id, version):
    """Full text of one explicit document version (no "latest" lookup)."""
    if not isinstance(doc_id, str) or not doc_id.strip():
        raise InvalidInputError("doc_id must be a non-empty string")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise InvalidInputError("version must be a positive int")
    row = store.connection.execute(
        "SELECT * FROM documents WHERE doc_id = ? AND version = ?", (doc_id, version)
    ).fetchone()
    if row is None:
        raise MissingContextError(f"missing {doc_id} v{version}")
    return dict(row)
