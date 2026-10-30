"""Error types of the example. Callers distinguish outcomes by type, never by
parsing messages.

@author Skorowid
"""


class ExampleError(Exception):
    """Base class for every error raised by this example."""


class InvalidInputError(ExampleError, ValueError):
    """An argument or fixture value has the wrong type, shape or range."""


class NotClaimableError(ExampleError):
    """The task exists but the sample claim policy rejects it.

    ``reasons`` lists every failed check, e.g. ``["dor_status=BLOCKED"]``.
    """

    def __init__(self, task_id, reasons):
        self.task_id = task_id
        self.reasons = list(reasons)
        super().__init__(f"task {task_id} is not claimable: {', '.join(self.reasons)}")


class ClaimConflictError(ExampleError):
    """Another run already holds an active claim on the task."""


class ClaimExpiredError(ExampleError):
    """The claim is past ``expires_at``; it needs explicit recovery."""


class ClaimNotFoundError(ExampleError):
    """No active claim matches the given id/run, or the task is unknown."""


class ContextError(ExampleError):
    """Base class for context assembly failures."""


class MissingContextError(ContextError):
    """A referenced document version (or the task/sprint) does not exist."""


class StaleContextError(ContextError):
    """A referenced version is no longer the latest approved one, or a
    previously built context no longer matches the store."""


class UnapprovedContextError(ContextError):
    """A referenced document version is not approved."""
