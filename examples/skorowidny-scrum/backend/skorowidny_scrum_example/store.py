"""Local SQLite backlog with atomic, expiring claims.

Sample claim policy (documented in README.md, NOT approved product behaviour):

* A task is claimable only when it belongs to the requested sprint, that
  sprint has status ``active``, ``dor_status`` is ``READY``, ``approved`` is
  true, ``exec_status`` is ``open`` and every dependency is ``done``.
* ``claim_next`` picks the claimable task with the lowest ``sprint_order``
  (ties broken by task id). Ordering is an explicit fixture field; nothing is
  inferred.
* One run holds at most one active claim. Repeating ``claim_next`` for the
  same run and the same sprint returns the existing claim (``reused=True``)
  instead of a second one; asking for another sprint while holding a claim
  raises ``ClaimConflictError`` (sample technical invariant).
* ``explain`` reports the same ``sprint_status=...`` reason as ``claim_next``
  for an inactive sprint, so ``[]`` always means claimable.
* A claim expires at ``claimed_at + ttl_seconds``; the caller always passes
  ``ttl_seconds`` -- there is no default.
* An expired claim is never silently taken over: the task stays ``claimed``
  until ``recover_expired`` is called explicitly; the recovery is recorded.

Atomicity: every mutation runs inside ``BEGIN IMMEDIATE`` (one writer at a
time) and a partial UNIQUE index forbids two active claims per task or run.

@author Skorowid
"""

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .errors import (
    ClaimConflictError,
    ClaimExpiredError,
    ClaimNotFoundError,
    InvalidInputError,
    NotClaimableError,
)

DOR_STATUSES = ("READY", "NEEDS CLARIFICATION", "BLOCKED", "CHANGE REQUEST")
EXEC_STATUSES = ("open", "claimed", "done")
SPRINT_STATUSES = ("planned", "active", "closed")
DOC_STATUSES = ("draft", "approved", "superseded")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sprints (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed'))
);
CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    sprint_id TEXT REFERENCES sprints(id),
    title TEXT NOT NULL,
    sprint_order INTEGER,
    dor_status TEXT NOT NULL CHECK (dor_status IN
        ('READY', 'NEEDS CLARIFICATION', 'BLOCKED', 'CHANGE REQUEST')),
    approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
    exec_status TEXT NOT NULL DEFAULT 'open'
        CHECK (exec_status IN ('open', 'claimed', 'done')),
    version INTEGER NOT NULL CHECK (version >= 1),
    acceptance TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS dependencies (
    task_id TEXT NOT NULL REFERENCES work_items(id),
    depends_on TEXT NOT NULL REFERENCES work_items(id),
    PRIMARY KEY (task_id, depends_on)
);
CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
);
CREATE TABLE IF NOT EXISTS task_doc_refs (
    task_id TEXT NOT NULL REFERENCES work_items(id),
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (task_id, doc_id)
);
CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES work_items(id),
    run_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'completed', 'recovered')),
    note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_claim_per_task
    ON claims(task_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_claim_per_run
    ON claims(run_id) WHERE status = 'active';
"""


def _utc_now():
    return datetime.now(timezone.utc)


def _to_text(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")


def _from_text(text):
    return datetime.fromisoformat(text)


def _require_text(name, value):
    if not isinstance(value, str) or not value.strip():
        raise InvalidInputError(f"{name} must be a non-empty string")
    return value


def _require_ttl(ttl_seconds):
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or ttl_seconds <= 0:
        raise InvalidInputError("ttl_seconds must be a positive int")
    return ttl_seconds


@dataclass(frozen=True)
class Claim:
    """An immutable snapshot of one claim row."""

    claim_id: str
    task_id: str
    run_id: str
    claimed_at: str
    expires_at: str
    status: str
    reused: bool = False
    note: str = None

    def to_dict(self):
        return {
            "claim_id": self.claim_id,
            "task_id": self.task_id,
            "run_id": self.run_id,
            "claimed_at": self.claimed_at,
            "expires_at": self.expires_at,
            "status": self.status,
            "reused": self.reused,
            "note": self.note,
        }


class BacklogStore:
    """One SQLite connection over a local backlog file (or ``:memory:``).

    Use one instance per thread; several instances may share one file.
    ``clock`` returns a timezone-aware ``datetime`` and exists so tests can
    move time without sleeping.
    """

    def __init__(self, path, clock=None, busy_timeout_s=10.0):
        self.path = str(path)
        self._clock = clock or _utc_now
        self._conn = sqlite3.connect(self.path, timeout=busy_timeout_s, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(_SCHEMA)

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    @property
    def connection(self):
        """The raw connection; used by the context builder and fixture loader."""
        return self._conn

    def _now(self):
        now = self._clock()
        if now.tzinfo is None:
            raise InvalidInputError("clock must return a timezone-aware datetime")
        return now

    def transaction(self):
        """Context manager: ``BEGIN IMMEDIATE`` ... ``COMMIT`` / ``ROLLBACK``."""
        return _Immediate(self._conn)

    # ----- claim policy -------------------------------------------------

    def _ineligibility(self, row, sprint_id):
        """Return the list of failed sample-policy checks for one task row."""
        reasons = []
        if row["sprint_id"] != sprint_id:
            reasons.append(f"not_in_sprint={sprint_id}")
        if row["dor_status"] != "READY":
            reasons.append(f"dor_status={row['dor_status']}")
        if not row["approved"]:
            reasons.append("not_approved")
        if row["exec_status"] != "open":
            reasons.append(f"exec_status={row['exec_status']}")
        open_deps = self._conn.execute(
            "SELECT d.depends_on FROM dependencies d JOIN work_items w ON w.id = d.depends_on"
            " WHERE d.task_id = ? AND w.exec_status != 'done' ORDER BY d.depends_on",
            (row["id"],),
        ).fetchall()
        reasons.extend(f"dependency_not_done={dep['depends_on']}" for dep in open_deps)
        return reasons

    def _active_sprint(self, sprint_id):
        sprint = self._conn.execute("SELECT * FROM sprints WHERE id = ?", (sprint_id,)).fetchone()
        if sprint is None:
            raise InvalidInputError(f"unknown sprint {sprint_id}")
        return sprint

    def _active_claim_for_run(self, run_id, now):
        row = self._conn.execute(
            "SELECT * FROM claims WHERE run_id = ? AND status = 'active'", (run_id,)
        ).fetchone()
        if row is None:
            return None
        if _from_text(row["expires_at"]) <= now:
            raise ClaimExpiredError(
                f"run {run_id} holds expired claim {row['claim_id']}; recover it explicitly"
            )
        return _claim(row, reused=True)

    def _insert_claim(self, task_id, run_id, now, ttl_seconds):
        claim_id = str(uuid.uuid4())
        expires = now + timedelta(seconds=ttl_seconds)
        self._conn.execute(
            "INSERT INTO claims (claim_id, task_id, run_id, claimed_at, expires_at, status)"
            " VALUES (?, ?, ?, ?, ?, 'active')",
            (claim_id, task_id, run_id, _to_text(now), _to_text(expires)),
        )
        updated = self._conn.execute(
            "UPDATE work_items SET exec_status = 'claimed' WHERE id = ? AND exec_status = 'open'",
            (task_id,),
        ).rowcount
        if updated != 1:  # defensive: the checks above run in the same transaction
            raise ClaimConflictError(f"task {task_id} changed state during claim")
        return Claim(claim_id, task_id, run_id, _to_text(now), _to_text(expires), "active")

    def claim_next(self, sprint_id, run_id, ttl_seconds):
        """Atomically claim the first claimable task of ``sprint_id``.

        Returns a ``Claim``, or ``None`` when nothing is claimable (use
        ``explain`` to see why). Raises ``InvalidInputError`` for bad
        arguments or an unknown sprint, ``NotClaimableError`` when the sprint
        is not active, ``ClaimExpiredError`` when the run's own claim expired,
        ``ClaimConflictError`` when the run already holds a claim in another
        sprint (a retry is idempotent only within the same sprint).
        """
        _require_text("sprint_id", sprint_id)
        _require_text("run_id", run_id)
        _require_ttl(ttl_seconds)
        with self.transaction():
            now = self._now()
            sprint = self._active_sprint(sprint_id)
            if sprint["status"] != "active":
                raise NotClaimableError(sprint_id, [f"sprint_status={sprint['status']}"])
            existing = self._active_claim_for_run(run_id, now)
            if existing is not None:
                held_sprint = self._conn.execute(
                    "SELECT sprint_id FROM work_items WHERE id = ?", (existing.task_id,)
                ).fetchone()["sprint_id"]
                if held_sprint != sprint_id:
                    raise ClaimConflictError(
                        f"run {run_id} already holds claim {existing.claim_id} on {existing.task_id}"
                        f" in sprint {held_sprint}, not {sprint_id}"
                    )
                return existing
            rows = self._conn.execute(
                "SELECT * FROM work_items WHERE sprint_id = ? AND sprint_order IS NOT NULL"
                " ORDER BY sprint_order, id",
                (sprint_id,),
            ).fetchall()
            for row in rows:
                if not self._ineligibility(row, sprint_id):
                    return self._insert_claim(row["id"], run_id, now, ttl_seconds)
            return None

    def claim_task(self, task_id, run_id, ttl_seconds):
        """Atomically claim one named task (in its own sprint).

        Same run again -> the existing claim with ``reused=True``. Another run
        holding it -> ``ClaimConflictError`` (``ClaimExpiredError`` if that
        claim is already expired and awaits recovery). Policy failure ->
        ``NotClaimableError`` listing every reason.
        """
        _require_text("task_id", task_id)
        _require_text("run_id", run_id)
        _require_ttl(ttl_seconds)
        with self.transaction():
            now = self._now()
            row = self._conn.execute("SELECT * FROM work_items WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise ClaimNotFoundError(f"unknown task {task_id}")
            held = self._conn.execute(
                "SELECT * FROM claims WHERE task_id = ? AND status = 'active'", (task_id,)
            ).fetchone()
            if held is not None:
                if held["run_id"] == run_id:
                    return self._active_claim_for_run(run_id, now)
                if _from_text(held["expires_at"]) <= now:
                    raise ClaimExpiredError(
                        f"task {task_id} has expired claim {held['claim_id']}; recover it explicitly"
                    )
                raise ClaimConflictError(f"task {task_id} is claimed by run {held['run_id']}")
            existing = self._active_claim_for_run(run_id, now)
            if existing is not None:
                raise ClaimConflictError(
                    f"run {run_id} already holds claim {existing.claim_id} on {existing.task_id}"
                )
            if row["sprint_id"] is None:
                raise NotClaimableError(task_id, ["not_in_sprint"])
            sprint = self._active_sprint(row["sprint_id"])
            reasons = self._ineligibility(row, row["sprint_id"])
            if sprint["status"] != "active":
                reasons.insert(0, f"sprint_status={sprint['status']}")
            if reasons:
                raise NotClaimableError(task_id, reasons)
            return self._insert_claim(task_id, run_id, now, ttl_seconds)

    def explain(self, sprint_id):
        """Map every task of the sprint to its failed checks (``[]`` = claimable)."""
        _require_text("sprint_id", sprint_id)
        sprint = self._active_sprint(sprint_id)
        inactive = [] if sprint["status"] == "active" else [f"sprint_status={sprint['status']}"]
        rows = self._conn.execute(
            "SELECT * FROM work_items WHERE sprint_id = ? ORDER BY sprint_order, id", (sprint_id,)
        ).fetchall()
        return {row["id"]: inactive + self._ineligibility(row, sprint_id) for row in rows}

    def _owned_active(self, claim_id, run_id):
        _require_text("claim_id", claim_id)
        _require_text("run_id", run_id)
        row = self._conn.execute(
            "SELECT * FROM claims WHERE claim_id = ? AND run_id = ? AND status = 'active'",
            (claim_id, run_id),
        ).fetchone()
        if row is None:
            raise ClaimNotFoundError(f"no active claim {claim_id} for run {run_id}")
        return row

    def complete(self, claim_id, run_id):
        """Mark the claimed task ``done``. An expired claim cannot complete."""
        with self.transaction():
            row = self._owned_active(claim_id, run_id)
            if _from_text(row["expires_at"]) <= self._now():
                raise ClaimExpiredError(f"claim {claim_id} expired at {row['expires_at']}")
            self._conn.execute("UPDATE claims SET status = 'completed' WHERE claim_id = ?", (claim_id,))
            self._conn.execute("UPDATE work_items SET exec_status = 'done' WHERE id = ?", (row["task_id"],))
            return self.get_claim(claim_id)

    def release(self, claim_id, run_id):
        """Give the task back (``open``) without completing it."""
        with self.transaction():
            row = self._owned_active(claim_id, run_id)
            self._conn.execute("UPDATE claims SET status = 'released' WHERE claim_id = ?", (claim_id,))
            self._conn.execute("UPDATE work_items SET exec_status = 'open' WHERE id = ?", (row["task_id"],))
            return self.get_claim(claim_id)

    def expired_claims(self):
        """Active claims already past ``expires_at`` -- candidates for recovery."""
        now = self._now()
        rows = self._conn.execute(
            "SELECT * FROM claims WHERE status = 'active' ORDER BY expires_at, claim_id"
        ).fetchall()
        return [_claim(row) for row in rows if _from_text(row["expires_at"]) <= now]

    def recover_expired(self, task_id, note):
        """Explicitly end an expired claim and reopen the task.

        ``note`` is required and stored on the claim: whoever recovers states
        what happens to work the lost run may have left behind.
        """
        _require_text("task_id", task_id)
        _require_text("note", note)
        with self.transaction():
            row = self._conn.execute(
                "SELECT * FROM claims WHERE task_id = ? AND status = 'active'", (task_id,)
            ).fetchone()
            if row is None:
                raise ClaimNotFoundError(f"task {task_id} has no active claim")
            if _from_text(row["expires_at"]) > self._now():
                raise ClaimConflictError(f"claim {row['claim_id']} has not expired yet")
            self._conn.execute(
                "UPDATE claims SET status = 'recovered', note = ? WHERE claim_id = ?",
                (note, row["claim_id"]),
            )
            self._conn.execute("UPDATE work_items SET exec_status = 'open' WHERE id = ?", (task_id,))
            return self.get_claim(row["claim_id"])

    def get_claim(self, claim_id):
        row = self._conn.execute("SELECT * FROM claims WHERE claim_id = ?", (claim_id,)).fetchone()
        if row is None:
            raise ClaimNotFoundError(f"unknown claim {claim_id}")
        return _claim(row)

    def task_status(self, task_id):
        row = self._conn.execute("SELECT exec_status FROM work_items WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise ClaimNotFoundError(f"unknown task {task_id}")
        return row["exec_status"]


def _claim(row, reused=False):
    return Claim(
        claim_id=row["claim_id"],
        task_id=row["task_id"],
        run_id=row["run_id"],
        claimed_at=row["claimed_at"],
        expires_at=row["expires_at"],
        status=row["status"],
        reused=reused,
        note=row["note"],
    )


class _Immediate:
    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        self._conn.execute("BEGIN IMMEDIATE")
        return self._conn

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self._conn.execute("COMMIT")
        else:
            self._conn.execute("ROLLBACK")
        return False
