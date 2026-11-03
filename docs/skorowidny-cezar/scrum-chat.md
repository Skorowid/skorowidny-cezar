# SCRUM-CHAT-01 — conversational Scrum and automatic queue

> Updated by [SCRUM-COORD-01](scrum-coordinator.md) on 2026-11-03: the thread now runs on OpenCode instead of Codex, and the coordinator may plan Sprints within limits the author agreed. Approval, no automatic Done, retry only on the author's instruction and durable forwarding (POL-1, POL-2) are unchanged and described here.

Status: implemented on `skorowidny/main` (2026-10-30); the user's decisions on Q1, Q2 and Q4 were implemented the same day (see [Approved follow-up policies](#approved-follow-up-policies-2026-10-30)). This increment builds on [SCRUM-LOCAL-01](scrum-integration.md).

## CHANGE REQUEST and DoR assessment

The request changes the approved SCRUM-LOCAL-01 baseline (an editable backlog form and an explicit Implement button), so it is a CHANGE REQUEST. The user approved it explicitly in the task order on 2026-10-30. The table separates what that approval covers, what was decided technically within it, and what is still open.

### Approved by the user (implemented)

| ID | Requirement | How |
|---|---|---|
| CHAT-1 | Replace the Add PBI form with an embedded chat permanently linked to a persistent, project-scoped Codex thread | The Scrum page shows a "Scrum assistant" panel; the Add PBI button is gone. The thread is a real cezar run on the Codex runner (read-only, in place), recorded in `state.json` → `chat.threadRunId`. |
| CHAT-2 | The creator describes problems, work, acceptance criteria, creates Sprints and sets guidelines through the chat | Backlog operations `setProductGoal`, `setDefinitionOfDone`, `setGuidelines`, `addItem`, `updateItem`, `approveItem`, `addSprint`, `updateSprint`, `planItem`, `unplanItem`, `addNote`. New optional state field `guidelines`, included in implementation prompts. |
| CHAT-3 | Ask for missing DoD or other essential requirements before an affected task is executable | Agent instructions require questions; the server keeps the SCRUM-LOCAL-01 readiness gate (`implementationBlockers`: READY, approved, criteria, no open questions, done dependencies, Product Goal, DoD, active Sprint with a goal), so an item with a gap is never queued. |
| CHAT-4 | Split complex work into tasks and group related tasks without inventing business requirements | Agent instructions; optional item field `group`. |
| CHAT-5 | Preserve provenance to chat decisions | Every operation must carry a verbatim `quote` of the user's words; the server refuses an operation whose quote is not in the thread's user messages. Items and Sprints keep `provenance` (run, turn, quote, time); `chat.log` records every applied/refused operation and queue action. |
| CHAT-6 | Maintain the local backlog | Operations are applied server-side to `.ai/cezar/scrum/state.json` under the existing lock, with the existing integrity rules. |
| CHAT-7 | A ready task is queued automatically for a free execution agent; no Implement click | After each chat turn and each backlog save, chat-made items (`autoQueue: true`) that pass the readiness gate get one run through the existing launcher (provider gate + `RunManager.startRun`); the run waits for a free `maxParallel` slot like any task. Further attempts: POL-2 below. |
| CHAT-8 | Reuse thread/session resumption, Codex runner, queue, RunManager/provider controls | Messages use the engine's ladder: live session → queued-prompt stack → start-up buffer → Continue (`codex thread/resume`). No second execution engine. |
| CHAT-9 | Project isolation; no duplicates across retries, restarts, concurrent calls | All state is per project data dir. A message carries `clientMessageId` (kept for the last 100). Thread creation, delivery, operation application (cursor `{runId, seq}` of the last absorbed `turn-end`) and `autoRunId` are written under the per-project lock in one atomic save. A run that started but could not be recorded is adopted by its `Scrum PBI id:` marker instead of starting a second one. |
| CHAT-10 | Do not read other projects; never auto-mark Done | Agent instructions limit reading to the project; chat operations cannot set delivery status or Done evidence, and an item that is Done cannot be changed from the chat. |
| CHAT-11 | Preserve existing backlog, Sprints, notes and run history | Only optional fields were added; existing files parse unchanged. `PUT /scrum` keeps server-owned fields (`chat`, `autoQueue`, `autoRunId`, `provenance`) from the stored state. |

### Technical decisions within the approved behaviour

- The chat agent never writes files. Its turns end with a fenced `cezar-scrum` JSON block that cezar parses from the persisted transcript after each `turn-end`. This keeps validation, locking and provenance on the server.
- The thread is pinned to Codex by its own one-step workflow (`scrum-chat`), independent of the project's `quick-task` or default runner. Implementation runs keep using the existing launcher (`quick-task`, the project's default runner, isolated worktree, not autonomous), exactly like the Implement button.
- When the thread can no longer be resumed (no session id, or pruned from run history) a new thread starts; the replacement and its reason are recorded in `chat.threads`, and the backlog file remains the shared memory.
- Auto-queue runs only when readiness may have changed (a new chat turn, a backlog save, boot catch-up), so a refused start is not retried on every poll.
- "Start implementation" is now "Start another attempt"; it still works for manual items and repeated attempts.

## Approved follow-up policies (2026-10-30)

The user answered Q1, Q2 and Q4 in the task order of 2026-10-30 (answers recorded verbatim: "Zmiana taska: Przekaż agentowi", "Ponowienia: Zapytaj na czacie", "Sprint: W aktywnym Sprincie") and delegated the implementation. They replace the conservative behaviour previously listed for those questions; everything else in SCRUM-CHAT-01 is unchanged.

| ID | Decision | Implementation |
|---|---|---|
| POL-1 (was Q1) | A chat change to an item whose execution run is queued, running or waiting is forwarded to that agent — not refused, not cancelled, not restarted. | The chat may now apply `updateItem`, `approveItem`, `planItem` and `unplanItem` to such an item (a Done item stays locked). For each active run of the item, one message per item and turn is recorded in `chat.forwards` in the same save that absorbs the turn, then delivered by a separate pass through the engine's durable rungs only (see [Forwarding semantics](#forwarding-semantics-pol-1-delivery)). The message restates the whole item, the user's words behind the change, the approval state and a `Scrum change id: <chat run>:<turn>:<item>` line. The conversation shows `forward-pending` (recorded, NOT received yet), `forwarded` (confirmed in the run's transcript or the prompt it started with) or `forward-failed` (will not reach that run, with the reason); the assistant must not claim delivery before `forwarded`. The existing CHANGE REQUEST rule still applies: a changed description or criteria withdraws approval, and the forwarded message tells the agent not to implement the change until approval is recorded and forwarded again. Nothing is launched for a busy item (`busyItemIds`, `autoRunId`). |
| POL-2 (was Q2) | A failed automatic attempt is never retried by itself; cezar reports it in the Scrum conversation and asks whether to retry. An explicit retry instruction in the chat allows one further attempt without an Implement click. | When the item's `autoRunId` run reaches `failed` (detected by a run-status listener, every chat read and boot catch-up), one `run-failed` notice with the run's error is logged, shown in the conversation and recorded in `autoFailureReported`, so it is not repeated. The assistant is instructed to ask; on the user's explicit answer it emits `retryItem`. The server refuses `retryItem` when its quote is not from a user message sent after the item's last attempt ended (an old "try again" cannot be reused), when the item has an active run, has no previous attempt, or fails the readiness gate. An accepted `retryItem` sets `autoRetry` (provenance of the instruction); the automatic queue starts exactly one run for it through the same launcher and clears it in the same save. A retry run that fails is reported and asked about again; nothing loops. |
| POL-4 (was Q4) | A ready item for which the user named no Sprint goes into the single active Sprint; with no active Sprint cezar asks in the chat and never creates one. An explicit Sprint choice is respected. | When a chat turn makes a chat-made item READY (created READY or moved to READY) and the item is in no planned or active Sprint and the same turn did not plan or unplan it explicitly, cezar plans it into the active Sprint (`autoPlan`, logged `applied`, Sprint provenance cites the words that made it READY). With no active Sprint it logs a `question` that is shown in the conversation and the assistant asks which Sprint to use. Only the READY transition triggers the policy, so a later manual or chat unplanning is not undone. |

### DoR reassessment after the decisions

| Requirement | Status | Rationale |
|---|---|---|
| POL-1 | READY, implemented | Decision approved; delivery uses existing engine mechanisms; outcome is observable. Durability and replay fixed 2026-10-30 (outbox); remaining limits under Forwarding semantics. |
| POL-2 | READY, implemented | Decision approved; "failed" is the run status `failed`. Cancelled runs and rejected results are not reported as failures (the user acted on them); they also never retry by themselves, and the user may still ask for another attempt through the chat. |
| POL-4 | READY, implemented | Decision approved; "ready" is DoR status READY. Approval is still required before the item is queued. |
| Q3, Q5, Q6, Q7 | unchanged | Not part of this decision; current behaviour below stays. |

### Conservative safeguards — need confirmation from ROOT (business decisions)

These were implemented as the most restrictive reading because the request does not decide them. Each can be relaxed once decided. Q1, Q2 and Q4 were decided on 2026-10-30 and moved to the policies above.

| ID | Question | Current behaviour | Priority |
|---|---|---|---|
| Q3 | Is a verbatim quote of the user's words sufficient evidence of explicit approval / Sprint instructions, or must approval be a separate confirmation step (e.g. a button)? | **Decided by the owner, 2026-11-03: a cited quote is sufficient to approve a backlog item.** No separate confirmation step. The quote must exist in the user's messages; the agent is instructed to ask again on ambiguous answers. The server can verify the quote exists, not what it means. | RESOLVED |
| Q5 | How are conflicting acceptance criteria resolved? | Never merged; the agent describes the conflict and asks. | BLOCKING for that behaviour |
| Q6 | Should changing the description or criteria of an approved item withdraw approval? | Yes (CHANGE REQUEST rule from the project instructions). | NON-BLOCKING |
| Q7 | Should automatically queued runs be autonomous (never park for the user)? | No; same as the existing Implement button. | NON-BLOCKING |

## Forwarding semantics (POL-1 delivery)

Technical correction of 2026-10-30; no business policy changed. It replaces the first POL-1 delivery, which could report a change held in the engine's in-memory start-up buffer as sent, lose it on restart, miss it in the replay guard, bypass the queued-prompt bounds and fail every waiting run without an open session.

1. **Durable before delivery.** An accepted change is written to `chat.forwards` in `.ai/cezar/scrum/state.json` (status `pending`, the full message text, the target run, the change id) in the same atomic save that applies the turn and moves the cursor. Nothing is handed to the engine before that save.
2. **Delivery pass.** A separate pass under the Scrum lock (`scrum/forward.ts`) runs after each reconcile, at boot catch-up, on every chat read while changes are open, and at most once per second when an event or status change of a target run arrives. Changes for one run go in the order they were made.
3. **Durable rungs only.** Live session (`RunManager.sendMessage`, which writes the transcript `user-message` before it reaches the backend), else the still-queued run's prompt (`enqueueMessage`, `queuedMessages` in runs.json) after the same `queuedStackRefusal` bounds the run message route applies. The in-memory start-up buffer (`deferMessage`) and Continue are not used for forwards.
4. **Outcomes.** `forwarded` only when the change id is in the run's transcript or in the queued prompt of a run that has since started. In a queued prompt of a run still queued it stays `queued` and is reported `forward-pending` ("NOT received yet"). `forward-failed` when the run ended (any non-active status) before either, when the run is gone, when the message exceeds the 100 000-character one-message limit (the requirements are never shortened), or when 50 changes are already waiting. A delivered or failed entry leaves the outbox; its outcome stays in `chat.log`.
5. **Held, not failed.** With no open session (starting, between steps, a waiting run parked without a session), a provider gate refusal, a queued prompt over its bounds, or a run waiting for the user's answer to its own question (`askParked`; a graph gate would take the change as its answer), the entry stays `pending` with the reason and a `forward-pending` notice. Nothing was handed over, so a later pass tries again; if the run ends first, the change is reported `forward-failed`.
6. **Replay and reconciliation.** Before any hand-over the pass looks for the change id in the run's transcript and queued prompt. A replayed turn does not add a second outbox entry for the same change and run. A crash after the hand-over but before the save leaves the entry pending; the next pass finds the id and records `forwarded` without sending again.

What is NOT guaranteed (no exact-once claim):

- `sendMessage` appends the transcript row before writing to the agent process. A crash between those two writes leaves the row, so the change is recorded as `forwarded` although the old session may never have read it (at most once in that window; it is not resent).
- When the run's event file cannot be written (cezar's degraded "events stay live-only" mode), the transcript has no row, so a crash before the outbox save can lead to a second delivery.
- runs.json is saved with a debounce. A crash before a stacked prompt reaches disk loses the stack entry; the outbox entry is still `queued`, the id is found nowhere, and the change is stacked again. Because the run index is written as a whole, a run that had already started with it would also be on disk, so this does not resend to a session that read it.
- An in-place run that gave the working tree back while parked accepts the message (transcript row) and hands it to the session after it reacquires the tree; if that session closes meanwhile, the engine's own fallback (queued prompt, else its in-memory buffer) applies. The change is already `forwarded` then, and that in-memory window is the engine's, not cezar Scrum's.
- "Delivered" means handed to the run's session or opening prompt; whether the agent follows it is not enforced.
- A run interrupted by a cezar restart reads `failed` until restart recovery continues it; a pass in that window reports its changes `forward-failed` (the backlog holds the updated item).
- A held change waits only as long as its run stays active; a parked run whose session never reopens keeps it `pending` until the run ends.

## API

Added to the Scrum family (also under `/api/v1/p/:projectId`):

- `GET /scrum/chat` → `ScrumChatView`: thread run id and status, messages of every thread (operation blocks folded) merged in time order with cezar's notices from the change log (role `system`: `forward-pending`, `forwarded`, `forward-failed`, `run-failed`, `question`), last 400, and the current state. Absorbs pending turns, reports failed automatic attempts and runs a delivery pass for open forwards first.
- `POST /scrum/chat/messages` `{clientMessageId, text}` → `{delivery, threadRunId, state}`; `delivery` is `started`, `delivered`, `queued`, `deferred`, `resumed` or `duplicate`. 409 when the provider is unavailable, the assistant is still answering, or a thread cannot start.
- `PUT /scrum` additionally queues chat-made items that became executable and ignores client values of server-owned fields.

Chat operations gained `retryItem`. Contract additions: item `autoRetry`, `autoFailureReported`; log outcomes above; `SCRUM_CHAT_NOTICE_OUTCOMES`; chat `forwards` (`scrumForwardSchema`, `SCRUM_FORWARD_LIMIT`, `SCRUM_FORWARD_TEXT_LIMIT`).

Contract: `packages/contract/src/scrum.ts` (`scrumChatStateSchema`, `scrumChatLogEntrySchema`, `scrumProvenanceSchema`, `scrumChatMessageInputSchema`, `scrumChatMessageResponseSchema`, `scrumChatViewSchema`, `scrumChatDeliverySchema`). Service: `packages/cezar/src/scrum/chat.ts`, `autoqueue.ts`, `policy.ts`, `forward.ts`, `packages/cezar/src/server/scrum.ts`. UI: `packages/web/src/routes/scrum/scrum-chat.tsx`.

## Known limitations

- Codex runs with the sandbox cezar configures for every Codex task; "read-only" for the chat is enforced by its instructions (cezar's existing read-only task mode), not by the OS. A misbehaving agent could edit `state.json` directly; a write that breaks the schema is detected as corrupt (503) and never overwritten.
- The quote check proves the words exist in the conversation, not that they mean consent. The owner accepted this for item approval (Q3).
- The cockpit polls `GET /scrum/chat` (2 s while the assistant works, 10 s otherwise) instead of a WebSocket topic.
- Any backlog change by the assistant bumps the revision; an unsaved manual edit then gets the existing 409 and must be reloaded.
- Forwarded changes: delivery semantics and their limits are under [Forwarding semantics](#forwarding-semantics-pol-1-delivery). The earlier limits (in-memory start-up buffer, replay guard blind to it, no queued-prompt bounds, waiting runs failed) were removed on 2026-10-30.
- The forwarded message tells the agent the approval state; the agent's compliance is not enforced by cezar.
- `run-failed` notices and auto-plan questions are written to the change log, which keeps the last 500 entries; the conversation shows them while they are in the log.
- Behaviour was not exercised against a live Codex account or a running server (see changes.md).
