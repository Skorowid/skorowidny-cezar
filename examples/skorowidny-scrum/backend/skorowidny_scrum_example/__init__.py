"""Standalone reference example: local SQLite backlog, atomic claims, compact
task context and Decimal calculations.

NOT integrated with the production Cezar backend. Every policy here is a
SAMPLE policy documented in README.md, not approved product behaviour.
Library modules never write to stdout.

@author Skorowid
"""

from .calc import calculate, load_rules
from .context import build_context, get_document, verify_context
from .errors import (
    ClaimConflictError,
    ClaimExpiredError,
    ClaimNotFoundError,
    ContextError,
    ExampleError,
    InvalidInputError,
    MissingContextError,
    NotClaimableError,
    StaleContextError,
    UnapprovedContextError,
)
from .fixtures import DEFAULT_FIXTURE, DEFAULT_RULES, load_fixture, load_fixture_data
from .store import BacklogStore, Claim

__all__ = [
    "BacklogStore",
    "Claim",
    "ClaimConflictError",
    "ClaimExpiredError",
    "ClaimNotFoundError",
    "ContextError",
    "DEFAULT_FIXTURE",
    "DEFAULT_RULES",
    "ExampleError",
    "InvalidInputError",
    "MissingContextError",
    "NotClaimableError",
    "StaleContextError",
    "UnapprovedContextError",
    "build_context",
    "calculate",
    "get_document",
    "load_fixture",
    "load_fixture_data",
    "load_rules",
    "verify_context",
]
