"""Demo driver. Prints JSON to stdout ONLY when run explicitly:

    python3 -m skorowidny_scrum_example.demo

Importing this module prints nothing; ``run_demo`` returns a dict.
Uses an in-memory database, the synthetic fixtures and a fixed clock, so the
output is deterministic apart from generated claim ids.

@author Skorowid
"""

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

from .calc import calculate, load_rules
from .context import build_context
from .errors import ContextError
from .fixtures import DEFAULT_FIXTURE, DEFAULT_RULES, load_fixture
from .store import BacklogStore

FIXED_NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)


class _Clock:
    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def run_demo(db_path=":memory:", ttl_seconds=900):
    """Walk the main paths of the example and return a JSON-safe summary."""
    clock = _Clock(FIXED_NOW)
    rules = load_rules(DEFAULT_RULES)
    steps = []
    with BacklogStore(db_path, clock=clock) as store:
        load_fixture(store, DEFAULT_FIXTURE)
        steps.append({"step": "explain SPR-1", "result": store.explain("SPR-1")})

        claim = store.claim_next("SPR-1", "demo-run-1", ttl_seconds)
        steps.append({"step": "claim_next demo-run-1", "result": claim.to_dict()})
        again = store.claim_next("SPR-1", "demo-run-1", ttl_seconds)
        steps.append({"step": "repeat claim_next demo-run-1", "result": again.to_dict()})
        steps.append({"step": "context", "result": build_context(store, claim.task_id)})
        steps.append({"step": "complete", "result": store.complete(claim.claim_id, "demo-run-1").to_dict()})

        second = store.claim_next("SPR-1", "demo-run-2", ttl_seconds)
        steps.append({"step": "claim_next demo-run-2", "result": second.to_dict()})
        clock.now = clock.now + timedelta(seconds=ttl_seconds + 1)
        steps.append({"step": "expired claims", "result": [c.to_dict() for c in store.expired_claims()]})
        recovered = store.recover_expired(second.task_id, "SAMPLE: run lost; leftover branch to be verified by a human")
        steps.append({"step": "recover_expired", "result": recovered.to_dict()})

        third = store.claim_next("SPR-1", "demo-run-3", ttl_seconds)
        try:
            build_context(store, "PBI-106")
            stale = None
        except ContextError as exc:
            stale = {"error": type(exc).__name__, "message": str(exc)}
        steps.append({"step": "claim_next demo-run-3", "result": third.to_dict()})
        steps.append({"step": "context PBI-106", "result": stale})

    steps.append({"step": "calc sum", "result": calculate(rules, "SAMPLE-SUM-HOURS", {"values": ["0.125", "0.5"]})})
    steps.append({"step": "calc percent", "result": calculate(rules, "SAMPLE-PERCENT-DONE", {"part": "1", "whole": "3"})})
    return {"example": "skorowidny-scrum backend (standalone, sample policy)", "now": FIXED_NOW.isoformat(), "steps": steps}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Standalone sample-policy demo; prints JSON.")
    parser.add_argument("--db", default=":memory:", help="SQLite path (default: in-memory; file must not exist)")
    parser.add_argument("--ttl", type=int, default=900, help="claim TTL in seconds for the demo")
    args = parser.parse_args(argv)
    json.dump(run_demo(args.db, args.ttl), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
