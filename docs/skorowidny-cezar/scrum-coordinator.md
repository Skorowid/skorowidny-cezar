# SCRUM-COORD-01 — product coordinator on OpenCode

Status: implemented, merged and exercised with a real OpenCode 2.2.5 coordinator on 2026-11-03 (evidence in [changes.md](changes.md)). This living specification extends [SCRUM-CHAT-01](scrum-chat.md) and [SCRUM-LOCAL-01](scrum-integration.md). The behaviour below was approved in the task order of 2026-11-02, which explicitly supersedes the earlier manual-only Sprint planning rule.

## Accountability

The human author is the accountable Product Owner. The coordinator is a tool: it prepares, asks, plans within limits and reports. It never approves a requirement, marks work Done or starts a retry by itself.

## Which rules come from where

| Rule | Source |
|---|---|
| Product Goal, Product Backlog and its ordering; Sprint with Sprint Goal and at most one month; Sprint Backlog; Increment and Definition of Done; one accountable Product Owner | **Scrum** (Scrum Guide 2020) |
| A forecast is not a commitment; refinement is ongoing, not a phase | **Scrum** |
| AI coordinator as the author's only conversation partner, acting as a PO/PM assistant | Custom AI PO/PM extension |
| Initial readiness gate before the first decomposition; the question catalogue; minimum BRD and FRD in Markdown | Custom extension |
| Definition of Ready and the READY / NEEDS CLARIFICATION / BLOCKED / CHANGE REQUEST statuses | Custom extension (the project's operating rules; DoR is not a Scrum artifact) |
| Value and profit objectives recorded separately in the author's words | Custom extension |
| Autonomous Sprint planning within agreed constraints | Custom extension. In Scrum, the whole Scrum Team plans a Sprint; here an AI proposes on the author's explicitly delegated limits, and the author remains accountable |
| Base estimate with a deterministic ×3 buffer | Custom extension. Scrum prescribes no estimation technique |
| Consultation, implementation and review agents; automatic queue; automatic review | Custom extension. Agents are tools; they are not Scrum Team members |
| Versioned documents, traces, context packets, result artifacts | Custom extension |

A Scrum Team is made of people. This module supports one human using agents, inspired by Scrum, and does not claim to be Scrum by itself: Scrum's events and accountabilities still need the humans who hold them.

## Definition of Ready, per slice

| ID | Slice | Status | Evidence of approval and open points |
|---|---|---|---|
| COORD-1 | One persistent coordinator on OpenCode; model from the configured choice | READY, implemented, exercised live | Approved. OC-1 resolved in the runner |
| COORD-2 | Vision, objectives, initial questions, minimum BRD/FRD gate | READY, implemented | Approved. The question catalogue and required headings are a technical proposal within that approval (from the project's BRD/FRD skeletons); NON-BLOCKING |
| COORD-3 | Versioned Markdown, human approval, traceability, compact index | READY, implemented | Approved |
| COORD-4 | Splitting rules | READY, implemented as instructions | Approved. Size and cohesion cannot be checked by software; the server checks readiness, dependencies and criteria |
| COORD-5 | Sprint planning within constraints; base and ×3 estimates | READY, implemented | Approved. The unit (minutes of working time) is a technical choice; NON-BLOCKING |
| COORD-6 | Real consult, implement and review agents; results return to the coordinator | READY, implemented | Approved. Automatic review on by default, switchable; at most 3 requests per author message: technical bounds; NON-BLOCKING |
| COORD-7 | Automatic queue, dependencies, idempotency, compatibility | READY, implemented | Approved; existing gate kept |
| COORD-8 | Cockpit views | READY, implemented | Approved |
| COORD-9 | Result presentation | READY, implemented | Approved. No preview is deployed by cezar; reuse is linking and the task's existing Preview tab |

Earlier questions stay as recorded in [scrum-chat.md](scrum-chat.md). Q3 is decided: a cited quote is enough to approve an item. For documents the author can use the chat or the explicit Approve button; both name one exact version.

## Coordinator

- A cezar run on the `opencode` runner, one-step workflow `scrum-chat`, read-only, in place, resumed through the engine's message ladder. There is one per project, in `chat.threadRunId`. A thread on another runner stays readable, and the next message starts the OpenCode successor (recorded in `chat.threads`).
- **Model resolution, first match wins:** `modelsLocked` → no model sent, OpenCode's own settings decide; the override saved in the cockpit; the project's `defaultModels.opencode`; OpenCode's settings file; otherwise no model is sent and OpenCode decides. No model name is written in the code. A changed choice applies when the session reopens.
- **Availability:** a missing OpenCode is reported by `GET /scrum/coordinator`, shown in the chat panel, and refuses `POST /scrum/chat/messages` with 409, rather than opening a thread that fails.
- **Read-only:** on OpenCode 2.x, session rules remove edit, write and shell. Reads outside the project are not blocked by those rules, so that part stays an instruction. On 1.x all of it is by instruction.
- **Resume:** on 2.x, Continue and restart recovery reopen the same OpenCode session. cezar's resume prompts are internal: not shown as the author's and not usable as a quote.
- **Refusals:** an operation cezar refuses appears in the conversation as a cezar notice and in `INDEX.md` for the next turn. Documents resolve by id or code.

## Initial readiness gate

`state.kickoff.required` is set when the coordinator first starts on a project with no items. An existing backlog gets `false` and is not gated.

While required and not passed, cezar refuses `addItem` and blocks implementation. It passes when:

1. every catalogue question (`SCRUM_KICKOFF_QUESTIONS`) has an answer; only non-essential ones may be deferred, and only with the author's words;
2. vision, Product Goal, Definition of Ready and Definition of Done are set;
3. one BRD and one FRD have all minimum headings and their latest versions are approved.

Value objectives need an answer, not a number: the author may say none are defined, and cezar assumes none. Missing business constraints are asked at runtime; there are no defaults. Once passed, the gate stays passed and refinement goes per slice.

## Documents: the shared memory

| What | Where | Notes |
|---|---|---|
| Immutable Markdown versions | `.ai/cezar/scrum/documents/<id>/vNNN.md` | Written before the state save that names them. Max 200 000 characters each, 2000 documents, 100 versions per requirement document |
| Metadata, hash, approval | `state.json` → `documents` | A read that does not match the hash reports `altered` or `missing`; such text is never used as a requirement |
| Compact index | `.ai/cezar/scrum/INDEX.md` | Generated on every save, at most 40 000 characters, says when it is cut |
| Item cards | `.ai/cezar/scrum/items/<id>.md` | Generated, rewritten only when changed |
| Context packet | A `context` document per item, part of each run's prompt | The item's traces, then approved stories and decisions, then the approved BRD/FRD, up to 60 000 characters. A document that does not fit is listed with its path, never cut |

Kinds: `brd`, `frd`, `story`, `decision` need human approval. `context`, `consultation`, `review`, `implementation` are generated or returned.

**Approval and change:** approval belongs to one version. A new version is unapproved. An item with `traces` is blocked until its traced version is the latest and approved; updating an approved item's traces withdraws the item's approval (CHANGE REQUEST rule). A legacy item without traces is not affected.

## Planning and estimates

- `setPlanningConstraints`, always citing the author: longest Sprint in days, earliest start, optional latest end, whether the coordinator may activate. No values are assumed.
- `planSprint` needs no quote, because its authority is those constraints, whose words become its provenance. cezar refuses it with no constraints, outside the dates, over the length, overlapping another open Sprint, without a goal, or activating when not allowed. Scrum's one-month limit and one active Sprint still apply to everything.
- `estimateItem`: base minutes; cezar stores `bufferedMinutes = baseMinutes × 3` and refuses a state where that does not hold. The cockpit and index always call it uncertain. It is neither a promise nor a readiness condition.

## Agents

Each assignment is one `state.work` entry over one real run of the existing engine, on the role's configured runner and model (null: project default runner, the runner's own model).

| Kind | Started by | How it runs |
|---|---|---|
| `consult` | `requestConsultation`, or the BA refinement button | Read-only, in place |
| `implement` | Automatic queue or the manual button | Its own worktree |
| `review` | Automatically once per settled attempt with a branch, or `requestReview` | Its own worktree, checks out the attempt's branch; told not to edit |

**Return path, all durable:**

1. A run settling or parking triggers a pass under the Scrum lock (also at boot and on chat reads).
2. The result is read from the run's persisted transcript: the `cezar-agent-result` block if it parses, otherwise the final text, labelled as such. It is stored as a Markdown document and on the work entry.
3. An inbox entry is written in the same save.
4. A separate pass hands all sendable entries to the coordinator as one message, between turns only: live session, queued prompt, or Continue.
5. The entry leaves the inbox only when the transcript shows the marker followed by a finished turn.

A session that died unanswered keeps the entry. It is sent again only after the author's next message or in a new thread, so a broken provider cannot cause a loop.

**Author's words stay the author's:** messages cezar writes into the thread start with `[cezar internal`. They are excluded from quote checks and from the conversation, so an agent's text can never become an approval.

**Bounds:** at most 3 consultations or reviews per author message (automatic reviews are not counted), 100 inbox entries (more wait on their work entries), 1000 work entries (the oldest settled ones fall off; their documents stay).

A review verdict is advice. "Changes" or "reject" does not retry anything: the coordinator reports it and the author decides.

## Queue

Unchanged path: `autoQueue` under the lock, the provider gate, `RunManager.startRun`, `maxParallel`. Added to the gate: the initial gate and the document baseline. Dependencies must still be Done, which only a human sets. Idempotency: `autoRunId` and work entries are written in the same save as the start; a run that started without being recorded is adopted by its marker (`Scrum PBI id:` or `Scrum agent work id:`).

## Result presentation

An agent declares results in its block; cezar checks each one.

| Kind | Accepted when | Stored as |
|---|---|---|
| `screenshot` | Regular file inside the run's worktree, no traversal or link out, PNG/JPEG/GIF/WebP with matching leading bytes, at most 50 MB | Copy with SHA-256 under `scrum/artifacts/<work>/`; shown inline with `nosniff` and a sandbox CSP |
| `file` | Same location rules; extension on the allow-list | Copy with SHA-256; served only as a download |
| `preview` | `http` or `https`, host `localhost`, `127.0.0.1` or `[::1]`, explicit port, no credentials; on check, not the cockpit itself | URL only. `unchecked` until the author presses Check, which sends one bounded request without following redirects. No command is ever run from it |

Everything else is `rejected`, with the reason, the declared value and the run. Each row shows status and provenance (run, time, hash). Implementation results also link the task's existing Preview tab. A local link only works in a browser on the machine running the preview.

## API

Added to the Scrum family (also under `/api/v1/p/:projectId`). Inputs are validated as middleware; schemas are in `packages/contract/src/scrum.ts`.

- `GET /scrum/coordinator` → `ScrumCoordinatorView`: configuration, resolved model and source, blocker, gate.
- `PUT /scrum/coordinator` `{expectedRevision, config}`: 409 on a stale revision or when naming a model under `modelsLocked`; 400 for a model of another runner.
- `GET /scrum/documents/:id?version=N` → content and integrity.
- `POST /scrum/documents/:id/decision` `{expectedRevision, version, decision}`: `approve` only the latest version; `revoke` only the approved one.
- `POST /scrum/artifacts/:id/check` → state, after one probe.
- `GET /scrum/artifacts/:id/content` → the verified copy.

New chat operations: `setVision`, `setValueObjectives`, `setDefinitionOfReady`, `setPlanningConstraints`, `clearPlanningConstraints`, `answerKickoff`, `addDocument`, `reviseDocument`, `approveDocument`, `estimateItem`, `requestConsultation`, `requestReview`, `planSprint`. Drafts, estimates, requests and `planSprint` need no quote because they decide nothing; a quote that is given is still checked. `PUT /scrum` keeps every new field server-owned.

## Open items

| ID | Priority | Issue | Who decides | Options |
|---|---|---|---|---|
| OC-1 | Resolved 2026-11-03 | The host's OpenCode 2.2.5 had no 1.x API | Owner order to complete the coordinator | The runner drives 2.x; OpenCode, its configuration and credentials were left unchanged |
| Q3 | Resolved 2026-11-03 by the owner | Is a cited quote sufficient approval of an item? | Owner | Yes. Current behaviour stands: quote accepted for items and documents; button also available for documents |

## Known limitations

- See [changes.md](changes.md) for what was and was not exercised. Only one small sandbox product has run through a real model, so how well models follow these instructions on larger work is unknown. In that run the model reported an operation as done before cezar applied it, which is why refusals are shown independently.
- An implementer that ends its turn without `CEZ:DONE` parks as `waiting`; its result still reaches the coordinator, and the run is closed by the idle timeout.
- `opencode serve` is not stopped by a cezar killed outside systemd. Under the service, the unit's control group ends it. Child sessions and their subtasks are not rendered, only their prompts are answered.
- Splitting quality, whether a quote really means consent and whether an agent told the truth in its summary cannot be verified by software. File and link claims can, and are.
- A run parked with a question (`waiting`) is reported to the coordinator, which tells the author, but the answer must be typed in that task's own page; the coordinator does not relay answers into other runs.
- Automatic review needs a branch. If the worktree was reclaimed before capture, declared files are recorded as rejected.
- Results are at least once: a crash, or an author message sent right after a hand-over, can show the coordinator the same result twice.
- The whole state is still one document: every saved agent result bumps the revision, so an unsaved manual form edit gets the existing 409 and must be reloaded.
- The cockpit polls (2 to 10 s) rather than using a WebSocket topic.
- `artifacts/` and old document versions are not pruned automatically.
- A `state.json` written by this version is not readable by older releases.
