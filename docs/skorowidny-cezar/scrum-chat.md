# SCRUM-CHAT-01 — conversational Scrum and automatic queue

Status: implemented on `skorowidny/main` (2026-10-30). This increment builds on [SCRUM-LOCAL-01](scrum-integration.md).

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
| CHAT-7 | A ready task is queued automatically for a free execution agent; no Implement click | After each chat turn and each backlog save, chat-made items (`autoQueue: true`) that pass the readiness gate get one run through the existing launcher (provider gate + `RunManager.startRun`); the run waits for a free `maxParallel` slot like any task. |
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

### Conservative safeguards — need confirmation from ROOT (business decisions)

These were implemented as the most restrictive reading because the request does not decide them. Each can be relaxed once decided.

| ID | Question | Current behaviour | Priority |
|---|---|---|---|
| Q1 | Can the assistant change an item whose execution run is still queued, running or waiting? If yes: cancel and re-queue, or send the change to the running agent? | Refused; the refusal is logged and the agent tells the user. | BLOCKING for that behaviour |
| Q2 | When an automatic run fails, is cancelled or its result is rejected, should the item be queued again automatically? | No: one automatic run per item (`autoRunId`); further attempts are manual. | BLOCKING for that behaviour |
| Q3 | Is a verbatim quote of the user's words sufficient evidence of explicit approval / Sprint instructions, or must approval be a separate confirmation step (e.g. a button)? | Quote must exist in the user's messages; the agent is instructed to ask again on ambiguous answers. The server can verify the quote exists, not what it means. | BLOCKING for approval semantics |
| Q4 | Which Sprint receives a ready item when the user did not name one? | None; the item is not executable until the user asks for it to be planned. | BLOCKING for that behaviour |
| Q5 | How are conflicting acceptance criteria resolved? | Never merged; the agent describes the conflict and asks. | BLOCKING for that behaviour |
| Q6 | Should changing the description or criteria of an approved item withdraw approval? | Yes (CHANGE REQUEST rule from the project instructions). | NON-BLOCKING |
| Q7 | Should automatically queued runs be autonomous (never park for the user)? | No; same as the existing Implement button. | NON-BLOCKING |

## API

Added to the Scrum family (also under `/api/v1/p/:projectId`):

- `GET /scrum/chat` → `ScrumChatView`: thread run id and status, messages of every thread (operation blocks folded, last 400), and the current state. Absorbs pending turns first.
- `POST /scrum/chat/messages` `{clientMessageId, text}` → `{delivery, threadRunId, state}`; `delivery` is `started`, `delivered`, `queued`, `deferred`, `resumed` or `duplicate`. 409 when the provider is unavailable, the assistant is still answering, or a thread cannot start.
- `PUT /scrum` additionally queues chat-made items that became executable and ignores client values of server-owned fields.

Contract: `packages/contract/src/scrum.ts` (`scrumChatStateSchema`, `scrumChatLogEntrySchema`, `scrumProvenanceSchema`, `scrumChatMessageInputSchema`, `scrumChatMessageResponseSchema`, `scrumChatViewSchema`, `scrumChatDeliverySchema`). Service: `packages/cezar/src/scrum/chat.ts`, `autoqueue.ts`, `packages/cezar/src/server/scrum.ts`. UI: `packages/web/src/routes/scrum/scrum-chat.tsx`.

## Known limitations

- Codex runs with the sandbox cezar configures for every Codex task; "read-only" for the chat is enforced by its instructions (cezar's existing read-only task mode), not by the OS. A misbehaving agent could edit `state.json` directly; a write that breaks the schema is detected as corrupt (503) and never overwritten.
- The quote check proves the words exist in the conversation, not that they mean consent (see Q3).
- The cockpit polls `GET /scrum/chat` (2 s while the assistant works, 10 s otherwise) instead of a WebSocket topic.
- Any backlog change by the assistant bumps the revision; an unsaved manual edit then gets the existing 409 and must be reloaded.
- Behaviour was not exercised against a live Codex account in this increment (see changes.md).
