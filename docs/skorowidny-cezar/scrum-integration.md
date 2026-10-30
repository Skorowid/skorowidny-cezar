# SCRUM-LOCAL-01 — integrated local Scrum module

Status: implemented (2026-10-30). Extended by [SCRUM-CHAT-01](scrum-chat.md): items are now created through the Scrum chat and queued automatically; the Add PBI form was removed. The user confirmed that the backlog lives inside skorowidny-cezar, asked for a working module in the cockpit and allowed switching the running service with a rollback procedure. Jira is not a data source for this increment.

The increment covers a per-project Product Goal and Definition of Done, an editable Product Backlog, BA questions and DoR status, Sprint Goal and Sprint Backlog, an event notebook, and starting the existing agent engine with PBI context. State is stored locally and survives restarts. Every agent attempt is linked to its PBI. A finished run never marks a PBI Done by itself. BA refinement is a read-only analysis; it never approves requirements on a human's behalf.

## Technical boundaries

- One contract module, `packages/contract/src/scrum.ts`, re-exported by the standard barrel. Every type is inferred from Zod.
- Per-project data in `.ai/cezar/scrum/state.json` (listed in the data `.gitignore`), written atomically (tmp + rename) under an in-process queue and a `proper-lockfile` lock. A missing file is an empty module; a corrupt file answers 503 and is never replaced with empty data.
- Optimistic concurrency: the client sends `expectedRevision`, the server increments `revision`; a 409 conflict never overwrites another edit.
- No automatic external integrations, schedules or new account model. Cezar's existing API security boundaries apply.

### Contract

Exports: `scrumStateSchema`, `scrumSaveInputSchema`, `scrumItemParamsSchema`, `scrumLaunchInputSchema`, `scrumLaunchResponseSchema`; types `ScrumState`, `ScrumItem`, `ScrumSprint`, `ScrumNote`, `ScrumSaveInput`, `ScrumLaunchResponse`. Additional exports: `scrumItemSchema`, `scrumSprintSchema`, `scrumNoteSchema`, the enum schemas `scrumDorStatusSchema`, `scrumDeliveryStatusSchema`, `scrumSprintStatusSchema`, `scrumNoteKindSchema`, `scrumLaunchModeSchema` with their types, `ScrumItemParams`, `ScrumLaunchInput` and `SCRUM_RUN_HISTORY_LIMIT` (1000).

`ScrumState`:

```text
schemaVersion: 1
revision: integer >= 0
productGoal: string
definitionOfDone: string
items: ScrumItem[]
sprints: ScrumSprint[]
notes: ScrumNote[]
```

`ScrumItem`: `id` (UUID), `title`, `description`, `acceptanceCriteria` (string[]), `dorStatus` (`READY`, `NEEDS CLARIFICATION`, `BLOCKED`, `CHANGE REQUEST`), `approved` (boolean), `questions` (string[]), `priority` (integer >= 1), `dependencies` (UUID[]), `deliveryStatus` (`open`, `in_progress`, `done`), `doneEvidence` (string), `runIds` (UUID[]).

`ScrumSprint`: `id` (UUID), `name`, `goal`, `startsOn`, `endsOn` (ISO calendar dates), `status` (`planned`, `active`, `closed`, `cancelled`), `itemIds` (UUID[]). Closed Sprints keep their plan for inspection. Only the active plan feeds agent work. Unfinished PBIs are not automatically promised to the next Sprint.

`ScrumNote`: `id` (UUID), `kind` (`general`, `planning`, `daily`, `review`, `retrospective`, `refinement`, `decision`, `question`), `body`, `itemId` (UUID or null), `sprintId` (UUID or null), `createdAt` (ISO datetime). Notes record decisions and questions; they do not replace events with people.

All objects are strict (unknown keys are rejected) and strings/arrays carry upper bounds so one file stays bounded.

### Project endpoints

- `GET /scrum` → `ScrumState`.
- `PUT /scrum` takes `{expectedRevision, state: ScrumState}` → `ScrumState`. Ids are unique, references must exist, dependencies may not form a cycle, at most one Sprint is active. A Sprint ends no later than one calendar month after it starts (`endsOn` ≤ `startsOn` + 1 month − 1 day, clamped to month end). A `done` PBI needs a Definition of Done and explicit evidence in `doneEvidence`. An edit cannot replace the server-recorded `runIds` of an existing item (400). Validation failures are 400, a stale revision is 409.
- `POST /scrum/items/:id/launch` takes `{expectedRevision, mode: 'implement' | 'refine'}` → `{state: ScrumState, runId: UUID}`. Unknown PBI: 404; conflicts and missing readiness: 409. Implementation requires READY, approved requirements, acceptance criteria, no open questions, done dependencies, a Product Goal, a DoD and a place in the active Sprint that has a goal. Refinement clarifies drafts and does not require READY. An item whose linked run is still `queued`, `running` or `waiting` cannot start a second one. A refused agent start is 409 and leaves the state unchanged.

Paths are mounted under the standard `/api/v1/p/:projectId` (and the boot alias `/api/v1`). The Hono family is chained and inputs are validated as middleware. The UI uses the typed client.

### Starting the agent

`createScrumRoutes` takes one callback, `launch(project: ProjectContext, prompt: string, readOnly: boolean): Promise<{id: string}>`. `server.ts` implements it with the built-in `quick-task` workflow, the existing provider availability gate and `RunManager.startRun`; the Scrum backend creates no second execution engine. Implementation runs get an isolated task worktree; refinement runs are read-only without a worktree. Runs also show on the existing Tasks page. Activity is checked in `project.store`, never through shared global project ids.

The callback runs under the state lock, so a concurrent launch of the same item waits and then fails on its stale revision instead of starting a second run.

The implementation prompt contains the Product Goal, the Sprint Goal and plan, the PBI description, criteria, questions, dependencies and DoD. It asks the agent to respect BA decisions, report new gaps instead of guessing, and work in the isolated worktree without merge or push. The refinement prompt forbids changing code or the backlog and asks for BLOCKING / NON-BLOCKING questions and labelled proposals only.

## Verification

See [changes.md](changes.md) for what was run. Screenshots of the real page on synthetic data: [screenshots](screenshots/README.md).

## Known limitations

- The whole state is one document: two people editing different items still conflict (409) and the second must reload.
- Deleting a PBI is allowed and drops its run links with it; notes or Sprints still referring to it must be updated in the same save.
- A run that started but whose link could not be written (disk failure right after start) stays visible on the Tasks page without a PBI link.
- `review` runs do not block a new attempt; only `queued`, `running` and `waiting` do.
- New Sprints need both dates before the next save is accepted.
