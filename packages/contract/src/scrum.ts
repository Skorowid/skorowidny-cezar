import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { runStatusSchema } from './runs.ts';

/**
 * SCRUM-LOCAL-01 (docs/skorowidny-cezar/scrum-integration.md): the project-local Product
 * Backlog, Sprint plans and notebook. These schemas are the wire SHAPE; cross-reference rules
 * (unique ids, dangling refs, dependency cycles, one active Sprint, Sprint length, Done
 * evidence) are enforced by the service in `packages/cezar/src/scrum/validate.ts`.
 *
 * @author Skorowid
 */
const id = z.uuid();
const text = (max: number) => z.string().max(max);
const lines = z.array(text(2000)).max(200);
/** Most attempts one item records; a launch past it is refused rather than written. */
export const SCRUM_RUN_HISTORY_LIMIT = 1000;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const scrumDorStatusSchema = z.enum(['READY', 'NEEDS CLARIFICATION', 'BLOCKED', 'CHANGE REQUEST']);
export type ScrumDorStatus = z.infer<typeof scrumDorStatusSchema>;
export const scrumDeliveryStatusSchema = z.enum(['open', 'in_progress', 'done']);
export type ScrumDeliveryStatus = z.infer<typeof scrumDeliveryStatusSchema>;
export const scrumSprintStatusSchema = z.enum(['planned', 'active', 'closed', 'cancelled']);
export type ScrumSprintStatus = z.infer<typeof scrumSprintStatusSchema>;
export const scrumNoteKindSchema = z.enum([
  'general', 'planning', 'daily', 'review', 'retrospective', 'refinement', 'decision', 'question',
]);
export type ScrumNoteKind = z.infer<typeof scrumNoteKindSchema>;

/**
 * SCRUM-CHAT-01: where a chat-made change came from — the Scrum chat run, the turn-end event
 * that carried it and the user's own words the agent cited. Server-owned.
 */
export const scrumProvenanceSchema = z.strictObject({
  runId: id,
  turnSeq: z.number().int().nonnegative(),
  quote: text(2000),
  at: z.iso.datetime({ offset: true }),
});
export type ScrumProvenance = z.infer<typeof scrumProvenanceSchema>;

/**
 * SCRUM-COORD-01 (docs/skorowidny-cezar/scrum-coordinator.md): an uncertain forecast, never a
 * promise. `bufferedMinutes` is always `baseMinutes * SCRUM_ESTIMATE_BUFFER_FACTOR`; the service
 * computes it and refuses a state where it differs.
 */
export const SCRUM_ESTIMATE_BUFFER_FACTOR = 3;
const MAX_ESTIMATE_MINUTES = 1_000_000;
export const scrumEstimateSchema = z.strictObject({
  baseMinutes: z.number().int().min(1).max(MAX_ESTIMATE_MINUTES),
  bufferedMinutes: z.number().int().min(SCRUM_ESTIMATE_BUFFER_FACTOR).max(MAX_ESTIMATE_MINUTES * SCRUM_ESTIMATE_BUFFER_FACTOR),
  factor: z.literal(SCRUM_ESTIMATE_BUFFER_FACTOR),
  rationale: text(2000),
  at: z.iso.datetime({ offset: true }),
  /** The coordinator thread that estimated, or null for an estimate recorded elsewhere. */
  runId: id.nullable(),
});
export type ScrumEstimate = z.infer<typeof scrumEstimateSchema>;

/** Which exact document version an item was derived from (traceability, CHANGE REQUEST guard). */
export const scrumTraceSchema = z.strictObject({
  documentId: id,
  version: z.number().int().min(1),
  section: text(200).optional(),
});
export type ScrumTrace = z.infer<typeof scrumTraceSchema>;

export const scrumItemSchema = z.strictObject({
  id,
  title: text(300),
  description: text(20_000),
  acceptanceCriteria: lines,
  dorStatus: scrumDorStatusSchema,
  approved: z.boolean(),
  questions: lines,
  priority: z.number().int().min(1).max(1_000_000),
  dependencies: z.array(id).max(500),
  deliveryStatus: scrumDeliveryStatusSchema,
  doneEvidence: text(20_000),
  /** Server-owned: appended by `POST /scrum/items/:id/launch`, never replaced by `PUT /scrum`. */
  runIds: z.array(id).max(SCRUM_RUN_HISTORY_LIMIT),
  /** SCRUM-CHAT-01: label that groups related tasks split from one request. */
  group: text(200).optional(),
  /** Server-owned (SCRUM-CHAT-01): made in the chat, so it queues itself once executable. */
  autoQueue: z.boolean().optional(),
  /** Server-owned: the latest run the automatic queue started for this item. */
  autoRunId: id.optional(),
  /** Server-owned (SCRUM-CHAT-01 Q2): an explicit chat retry instruction the queue has not used yet. */
  autoRetry: scrumProvenanceSchema.optional(),
  /** Server-owned: the failed automatic run already reported in the chat. */
  autoFailureReported: id.optional(),
  /** Server-owned: the chat decisions that created or changed this item. */
  provenance: z.array(scrumProvenanceSchema).max(200).optional(),
  /** Server-owned (SCRUM-COORD-01): base and deterministic ×3 buffered forecast. */
  estimate: scrumEstimateSchema.optional(),
  /** Server-owned (SCRUM-COORD-01): the document versions this item implements. */
  traces: z.array(scrumTraceSchema).max(50).optional(),
});
export type ScrumItem = z.infer<typeof scrumItemSchema>;

export const scrumSprintSchema = z.strictObject({
  id,
  name: text(300),
  goal: text(5000),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  status: scrumSprintStatusSchema,
  itemIds: z.array(id).max(1000),
  /** Server-owned: the chat decisions that created or changed this Sprint. */
  provenance: z.array(scrumProvenanceSchema).max(200).optional(),
});
export type ScrumSprint = z.infer<typeof scrumSprintSchema>;

export const scrumNoteSchema = z.strictObject({
  id,
  kind: scrumNoteKindSchema,
  body: text(20_000),
  itemId: id.nullable(),
  sprintId: id.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ScrumNote = z.infer<typeof scrumNoteSchema>;

/**
 * A chat change to an item with an active run (Q1): `forward-pending` — recorded durably, not yet
 * received by the agent (held, or waiting in the run's queued prompt); `forwarded` — confirmed in
 * the run's transcript or opening prompt; `forward-failed` — it will not reach that run.
 * `run-failed`: an automatic attempt failed and is not retried by itself (Q2).
 * `question`: cezar needs the user's answer, e.g. no active Sprint for a READY item (Q4).
 */
export const scrumChatOutcomeSchema = z.enum(['applied', 'refused', 'queued', 'queue-failed', 'forward-pending', 'forwarded', 'forward-failed', 'run-failed', 'question', 'agent-started', 'agent-result']);
/** Outcomes the conversation shows inline as cezar's own notices. */
export const SCRUM_CHAT_NOTICE_OUTCOMES: readonly ScrumChatOutcome[] = ['forward-pending', 'forwarded', 'forward-failed', 'run-failed', 'question', 'agent-started', 'agent-result', 'refused'];
export type ScrumChatOutcome = z.infer<typeof scrumChatOutcomeSchema>;

/** One backlog operation the chat agent asked for, or one automatic queue action, and its result. */
export const scrumChatLogEntrySchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  /** The chat run whose turn caused this; null for a queue action after a backlog save. */
  runId: id.nullable(),
  turnSeq: z.number().int().nonnegative(),
  op: text(40),
  outcome: scrumChatOutcomeSchema,
  detail: text(2000),
  quote: text(2000),
  itemId: id.nullable(),
  sprintId: id.nullable(),
});
export type ScrumChatLogEntry = z.infer<typeof scrumChatLogEntrySchema>;
/** Most log entries kept; older ones fall off (item/Sprint provenance stays). */
export const SCRUM_CHAT_LOG_LIMIT = 500;

/** Longest forwarded change: the engine's one-turn message limit (`MAX_MESSAGE_TEXT_CHARS`). */
export const SCRUM_FORWARD_TEXT_LIMIT = 100_000;
/** Most forwarded changes waiting for delivery at once; a change past it is refused, never dropped silently. */
export const SCRUM_FORWARD_LIMIT = 50;

/**
 * SCRUM-CHAT-01 Q1 outbox entry: one accepted chat change for one active run, written to
 * `state.json` before any delivery is tried. `pending`: nothing handed to the engine yet;
 * `queued`: stacked onto the still-queued run's prompt, not yet received. Removed once the change
 * is confirmed delivered or has failed (the outcome stays in `log`).
 */
export const scrumForwardSchema = z.strictObject({
  changeId: text(200),
  itemId: id,
  runId: id,
  text: z.string().max(SCRUM_FORWARD_TEXT_LIMIT),
  quote: text(2000),
  origin: z.strictObject({ runId: id, turnSeq: z.number().int().nonnegative() }),
  createdAt: z.iso.datetime({ offset: true }),
  status: z.enum(['pending', 'queued']),
  /** Why it has not been received yet. */
  detail: text(2000),
});
export type ScrumForward = z.infer<typeof scrumForwardSchema>;

/** Most agent results waiting to enter the coordinator's thread at once; more wait on their work entry. */
export const SCRUM_INBOX_LIMIT = 100;
/**
 * SCRUM-COORD-01: one persisted agent result on its way into the coordinator's thread. Same
 * discipline as `forwards`: written before delivery, removed once confirmed in the transcript.
 */
export const scrumInboxEntrySchema = z.strictObject({
  id,
  workId: id,
  text: text(12_000),
  createdAt: z.iso.datetime({ offset: true }),
  /** Why it has not reached the coordinator yet. */
  detail: text(2000),
  /** Handed to this thread at this time; the entry stays until the coordinator has answered. */
  handedAt: z.iso.datetime({ offset: true }).optional(),
  handedRunId: id.optional(),
});
export type ScrumInboxEntry = z.infer<typeof scrumInboxEntrySchema>;

/**
 * SCRUM-CHAT-01, server-owned: the project's Scrum chat thread (a real agent run resumed through
 * Continue), the turn the backlog has absorbed up to, recent client message ids for retries, and
 * chat changes still on their way to active runs.
 */
export const scrumChatStateSchema = z.strictObject({
  threadRunId: id.nullable(),
  threads: z.array(z.strictObject({ runId: id, startedAt: z.iso.datetime({ offset: true }), reason: text(500) })).max(200),
  cursor: z.strictObject({ runId: id, seq: z.number().int().nonnegative() }).nullable(),
  messageIds: z.array(id).max(100),
  log: z.array(scrumChatLogEntrySchema).max(SCRUM_CHAT_LOG_LIMIT),
  forwards: z.array(scrumForwardSchema).max(SCRUM_FORWARD_LIMIT).optional(),
  /** SCRUM-COORD-01: agent results still on their way into the coordinator's thread. */
  inbox: z.array(scrumInboxEntrySchema).max(SCRUM_INBOX_LIMIT).optional(),
});
export type ScrumChatState = z.infer<typeof scrumChatStateSchema>;

/** Longest one Markdown document version, in characters. */
export const SCRUM_DOCUMENT_TEXT_LIMIT = 200_000;
export const SCRUM_DOCUMENT_LIMIT = 2000;
export const SCRUM_DOCUMENT_VERSION_LIMIT = 100;
/** Longest context packet handed to a run; what does not fit is listed by path, never cut silently. */
export const SCRUM_CONTEXT_PACKET_LIMIT = 60_000;

/**
 * SCRUM-COORD-01: `brd`, `frd`, `story`, `decision` are prepared by the coordinator and need human
 * approval; `context` is generated per item; `consultation`, `review` and `implementation` are
 * what agents actually returned.
 */
export const scrumDocumentKindSchema = z.enum(['brd', 'frd', 'story', 'decision', 'context', 'consultation', 'review', 'implementation']);
export type ScrumDocumentKind = z.infer<typeof scrumDocumentKindSchema>;
/** Kinds whose content is a requirement or decision: only a human approval gives them force. */
export const SCRUM_APPROVABLE_DOCUMENT_KINDS: readonly ScrumDocumentKind[] = ['brd', 'frd', 'story', 'decision'];

export const scrumDocumentVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  /** SHA-256 of the Markdown file; a read that does not match reports the file as altered. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chars: z.number().int().nonnegative().max(SCRUM_DOCUMENT_TEXT_LIMIT),
  /** Markdown headings found in this version; the minimum BRD/FRD check reads them. */
  headings: z.array(text(200)).max(200),
  summary: text(500),
  at: z.iso.datetime({ offset: true }),
  /** Who wrote it: the coordinator's draft, cezar's generator, or an agent run's result. */
  source: z.enum(['coordinator', 'cezar', 'agent']),
  provenance: scrumProvenanceSchema.nullable(),
  runId: id.nullable(),
});
export type ScrumDocumentVersion = z.infer<typeof scrumDocumentVersionSchema>;

export const scrumDocumentSchema = z.strictObject({
  id,
  /** Human-readable, stable: `BRD-1`, `FRD-2`, `REVIEW-3`. */
  code: text(40),
  kind: scrumDocumentKindSchema,
  title: text(300),
  itemIds: z.array(id).max(500),
  versions: z.array(scrumDocumentVersionSchema).min(1).max(SCRUM_DOCUMENT_VERSION_LIMIT),
  /** The one version a human approved; a newer version is not approved by it. */
  approval: z.strictObject({
    version: z.number().int().min(1),
    by: z.enum(['chat', 'cockpit']),
    at: z.iso.datetime({ offset: true }),
    provenance: scrumProvenanceSchema.nullable(),
  }).nullable(),
});
export type ScrumDocument = z.infer<typeof scrumDocumentSchema>;

/** Questions the coordinator must have answered (or, where allowed, explicitly deferred) before the first decomposition. */
export const SCRUM_KICKOFF_QUESTIONS = [
  { id: 'vision', topic: 'Vision', essential: true, question: 'What should this product be and for whom, in your own words?' },
  { id: 'value', topic: 'Value and profit objectives', essential: true, question: 'What value or profit objectives do you define, and how would you measure them? State "none defined" if you have none; none are assumed for you.' },
  { id: 'users', topic: 'Users and accountability', essential: true, question: 'Who are the users and stakeholders, and who approves requirements as the accountable Product Owner?' },
  { id: 'scope', topic: 'Scope', essential: true, question: 'What is in scope now, explicitly out of scope, and deferred?' },
  { id: 'behavior', topic: 'Functional behaviour', essential: true, question: 'What are the main actors, triggers, flows and expected results of the first slice?' },
  { id: 'dor', topic: 'Definition of Ready', essential: true, question: 'What must be true before a task may start (Definition of Ready)?' },
  { id: 'dod', topic: 'Definition of Done', essential: true, question: 'What must be true before work counts as Done (Definition of Done)?' },
  { id: 'planning', topic: 'Sprint planning constraints', essential: true, question: 'What Sprint length and date limits apply, and may the coordinator plan and activate Sprints within them on its own?' },
  { id: 'data', topic: 'Data and business rules', essential: false, question: 'Which data, validation and business rules apply?' },
  { id: 'failures', topic: 'Failure scenarios', essential: false, question: 'Which errors, boundary cases and recovery behaviour matter?' },
  { id: 'integrations', topic: 'Dependencies', essential: false, question: 'Which external systems, APIs or decisions does the work depend on?' },
  { id: 'quality', topic: 'Quality constraints', essential: false, question: 'Which performance, security, compliance or availability constraints apply?' },
  { id: 'limits', topic: 'Cost and time limits', essential: false, question: 'Which budget or time limits apply to agent work?' },
  { id: 'delivery', topic: 'Delivery', essential: false, question: 'Which repositories are affected, and who may merge or publish?' },
] as const;
export const scrumKickoffQuestionIdSchema = z.enum(['vision', 'value', 'users', 'scope', 'behavior', 'dor', 'dod', 'planning', 'data', 'failures', 'integrations', 'quality', 'limits', 'delivery']);
export type ScrumKickoffQuestionId = z.infer<typeof scrumKickoffQuestionIdSchema>;

export const scrumKickoffSchema = z.strictObject({
  /** True when the project had no backlog when the coordinator started: the gate applies. An existing backlog keeps working without it. */
  required: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  answers: z.array(z.strictObject({
    questionId: scrumKickoffQuestionIdSchema,
    status: z.enum(['answered', 'deferred']),
    answer: text(5000),
    provenance: scrumProvenanceSchema,
  })).max(100),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ScrumKickoff = z.infer<typeof scrumKickoffSchema>;

/** The limits within which the coordinator may plan Sprints by itself; only the author sets them. */
export const scrumPlanningConstraintsSchema = z.strictObject({
  maxSprintDays: z.number().int().min(1).max(31),
  earliestStart: z.iso.date(),
  latestEnd: z.iso.date().nullable(),
  mayActivate: z.boolean(),
  notes: text(2000),
  provenance: scrumProvenanceSchema,
});
export type ScrumPlanningConstraints = z.infer<typeof scrumPlanningConstraintsSchema>;

/** The author's own product statements. Nothing here has a default: an empty value means not stated. */
export const scrumProductSchema = z.strictObject({
  vision: text(10_000),
  valueObjectives: z.array(z.strictObject({
    id,
    statement: text(2000),
    /** How the author measures it; empty when the author named no metric. */
    metric: text(500),
    target: text(500),
    provenance: scrumProvenanceSchema,
  })).max(50),
  definitionOfReady: text(20_000),
  planning: scrumPlanningConstraintsSchema.nullable(),
});
export type ScrumProduct = z.infer<typeof scrumProductSchema>;

export const scrumAgentRoleSchema = z.enum(['consult', 'implement', 'review']);
export type ScrumAgentRole = z.infer<typeof scrumAgentRoleSchema>;
/** Null runner: the project's default runner. Null model: that runner's own configured choice. */
export const scrumAgentChoiceSchema = z.strictObject({ runner: runnerSchema.nullable(), model: text(200).nullable() });
export type ScrumAgentChoice = z.infer<typeof scrumAgentChoiceSchema>;
/** The coordinator's runner is always OpenCode; `model` null means the configured OpenCode choice. */
export const scrumCoordinatorConfigSchema = z.strictObject({
  model: text(200).nullable(),
  agents: z.strictObject({ consult: scrumAgentChoiceSchema, implement: scrumAgentChoiceSchema, review: scrumAgentChoiceSchema }),
  /** A settled implementation attempt with a branch gets one independent review run. */
  autoReview: z.boolean(),
});
export type ScrumCoordinatorConfig = z.infer<typeof scrumCoordinatorConfigSchema>;

export const SCRUM_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
export const SCRUM_ARTIFACTS_PER_RESULT = 10;
/**
 * A result an agent presented, as cezar verified it. `verified`: the file existed, passed the
 * allow-list and was copied with this hash. `rejected`: refused, see `reason`. `unchecked`,
 * `reachable`, `unreachable`: a loopback preview link and its last probe. A declared item that
 * failed validation is recorded as rejected, never shown as existing.
 */
export const scrumArtifactSchema = z.strictObject({
  id,
  kind: z.enum(['screenshot', 'file', 'preview']),
  label: text(300),
  status: z.enum(['verified', 'rejected', 'unchecked', 'reachable', 'unreachable']),
  reason: text(500),
  /** What the agent declared: a path inside its worktree, or a URL. */
  declared: text(2000),
  /** A validated loopback preview URL; absent for files and rejected links. */
  url: text(2000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bytes: z.number().int().nonnegative().max(SCRUM_ARTIFACT_MAX_BYTES).optional(),
  mediaType: text(100).optional(),
  /** File name under `scrum/artifacts/<work id>/`. */
  storedAs: text(200).optional(),
  runId: id,
  capturedAt: z.iso.datetime({ offset: true }),
  checkedAt: z.iso.datetime({ offset: true }).optional(),
});
export type ScrumArtifact = z.infer<typeof scrumArtifactSchema>;

export const SCRUM_WORK_LIMIT = 1000;
export const scrumWorkKindSchema = z.enum(['consult', 'implement', 'review']);
export type ScrumWorkKind = z.infer<typeof scrumWorkKindSchema>;
/** `pending`: recorded, no run yet. `active`: queued or running. `waiting`: the run parked for an answer. */
export const scrumWorkStatusSchema = z.enum(['pending', 'active', 'waiting', 'completed', 'failed', 'cancelled']);
export type ScrumWorkStatus = z.infer<typeof scrumWorkStatusSchema>;

/** What the run really returned, read from its persisted transcript. */
export const scrumWorkResultSchema = z.strictObject({
  /** `structured`: the agent's result block parsed; `transcript`: only its final text; `none`: no text at all. */
  source: z.enum(['structured', 'transcript', 'none']),
  verdict: z.enum(['approve', 'changes', 'reject']).nullable(),
  summary: text(4000),
  gaps: lines,
  blockers: lines,
  feasibility: text(2000),
  documentId: id.nullable(),
  documentVersion: z.number().int().min(1).nullable(),
  seq: z.number().int().nonnegative(),
  capturedAt: z.iso.datetime({ offset: true }),
});
export type ScrumWorkResult = z.infer<typeof scrumWorkResultSchema>;

/** One real agent assignment: an existing cezar run behind it, its status and its returned result. */
export const scrumWorkSchema = z.strictObject({
  id,
  kind: scrumWorkKindSchema,
  itemId: id.nullable(),
  documentId: id.nullable(),
  request: text(4000),
  runId: id.nullable(),
  /** `review`: the implementation run under review. */
  targetRunId: id.nullable(),
  runner: runnerSchema.nullable(),
  model: text(200).nullable(),
  branch: text(300).nullable(),
  status: scrumWorkStatusSchema,
  detail: text(2000),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  result: scrumWorkResultSchema.nullable(),
  artifacts: z.array(scrumArtifactSchema).max(SCRUM_ARTIFACTS_PER_RESULT),
  /** Last state already reported to the coordinator, so one result is delivered once. */
  reportedKey: text(200),
  /** The author's words behind a requested consultation or review, when any. */
  provenance: scrumProvenanceSchema.nullable(),
});
export type ScrumWork = z.infer<typeof scrumWorkSchema>;

export const scrumStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision,
  productGoal: text(5000),
  definitionOfDone: text(20_000),
  items: z.array(scrumItemSchema).max(1000),
  sprints: z.array(scrumSprintSchema).max(500),
  notes: z.array(scrumNoteSchema).max(5000),
  /** SCRUM-CHAT-01: working guidelines the project creator set for every task. */
  guidelines: text(20_000).optional(),
  /** Server-owned (SCRUM-CHAT-01); `PUT /scrum` keeps the stored value whatever it sends. */
  chat: scrumChatStateSchema.optional(),
  /** Server-owned (SCRUM-COORD-01): coordinator and agent choices, changed through `PUT /scrum/coordinator`. */
  coordinator: scrumCoordinatorConfigSchema.optional(),
  /** Server-owned (SCRUM-COORD-01): the initial readiness gate. */
  kickoff: scrumKickoffSchema.optional(),
  /** Server-owned (SCRUM-COORD-01): vision, value objectives, DoR and planning limits the author stated. */
  product: scrumProductSchema.optional(),
  /** Server-owned (SCRUM-COORD-01): metadata of the versioned Markdown files under `scrum/documents/`. */
  documents: z.array(scrumDocumentSchema).max(SCRUM_DOCUMENT_LIMIT).optional(),
  /** Server-owned (SCRUM-COORD-01): agent assignments and their returned results. */
  work: z.array(scrumWorkSchema).max(SCRUM_WORK_LIMIT).optional(),
});
export type ScrumState = z.infer<typeof scrumStateSchema>;

/** `PUT /scrum`: the whole state, guarded by the revision the client last read. */
export const scrumSaveInputSchema = z.strictObject({ expectedRevision: revision, state: scrumStateSchema });
export type ScrumSaveInput = z.infer<typeof scrumSaveInputSchema>;

export const scrumItemParamsSchema = z.object({ id });
export type ScrumItemParams = z.infer<typeof scrumItemParamsSchema>;

export const scrumLaunchModeSchema = z.enum(['implement', 'refine']);
export type ScrumLaunchMode = z.infer<typeof scrumLaunchModeSchema>;
export const scrumLaunchInputSchema = z.strictObject({ expectedRevision: revision, mode: scrumLaunchModeSchema });
export type ScrumLaunchInput = z.infer<typeof scrumLaunchInputSchema>;

export const scrumLaunchResponseSchema = z.strictObject({ state: scrumStateSchema, runId: id });
export type ScrumLaunchResponse = z.infer<typeof scrumLaunchResponseSchema>;

/** `POST /scrum/chat/messages`: one user message; `clientMessageId` makes a retry answer once. */
export const scrumChatMessageInputSchema = z.strictObject({ clientMessageId: id, text: z.string().trim().min(1).max(20_000) });
export type ScrumChatMessageInput = z.infer<typeof scrumChatMessageInputSchema>;

/** How the message reached the thread: a new thread, the live session, its queue/start-up buffer, a resumed session, or a retry. */
export const scrumChatDeliverySchema = z.enum(['started', 'delivered', 'queued', 'deferred', 'resumed', 'duplicate']);
export type ScrumChatDelivery = z.infer<typeof scrumChatDeliverySchema>;
export const scrumChatMessageResponseSchema = z.strictObject({ delivery: scrumChatDeliverySchema, threadRunId: id, state: scrumStateSchema });
export type ScrumChatMessageResponse = z.infer<typeof scrumChatMessageResponseSchema>;

export const scrumChatMessageSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  /** `system`: a cezar notice from the change log (delivery, failure, question), not a model turn. */
  role: z.enum(['user', 'agent', 'system']),
  text: z.string().max(200_000),
  at: z.string().max(64),
});
export type ScrumChatMessage = z.infer<typeof scrumChatMessageSchema>;

/** `GET /scrum/chat`: the thread's conversation (backlog operation blocks removed) and status. */
export const scrumChatViewSchema = z.strictObject({
  threadRunId: id.nullable(),
  threadStatus: runStatusSchema.nullable(),
  threadRunner: runnerSchema.nullable(),
  messages: z.array(scrumChatMessageSchema).max(400),
  truncated: z.boolean(),
  state: scrumStateSchema,
});
export type ScrumChatView = z.infer<typeof scrumChatViewSchema>;

/** Where the coordinator's model comes from. `locked`: `modelsLocked` makes OpenCode's native settings authoritative. */
export const scrumCoordinatorModelSourceSchema = z.enum(['override', 'project-default', 'opencode-settings', 'opencode-own-default', 'locked']);
export type ScrumCoordinatorModelSource = z.infer<typeof scrumCoordinatorModelSourceSchema>;

/** `GET /scrum/coordinator`: the configuration, the model it resolves to and the readiness gate. */
export const scrumCoordinatorViewSchema = z.strictObject({
  revision,
  config: scrumCoordinatorConfigSchema,
  runner: z.literal('opencode'),
  /** Null: OpenCode decides by its own configuration; cezar names no model. */
  resolvedModel: z.string().max(200).nullable(),
  modelSource: scrumCoordinatorModelSourceSchema,
  modelsLocked: z.boolean(),
  /** Why the coordinator cannot run on this machine right now, e.g. an unsupported OpenCode version. */
  blocker: z.string().max(1000).nullable(),
  kickoff: z.strictObject({
    required: z.boolean(),
    complete: z.boolean(),
    blockers: z.array(text(500)).max(100),
    questions: z.array(z.strictObject({
      id: scrumKickoffQuestionIdSchema,
      topic: text(200),
      question: text(500),
      essential: z.boolean(),
      status: z.enum(['open', 'answered', 'deferred']),
      answer: text(5000),
    })).max(50),
  }),
});
export type ScrumCoordinatorView = z.infer<typeof scrumCoordinatorViewSchema>;

export const scrumCoordinatorSaveSchema = z.strictObject({ expectedRevision: revision, config: scrumCoordinatorConfigSchema });
export type ScrumCoordinatorSave = z.infer<typeof scrumCoordinatorSaveSchema>;

export const scrumDocumentParamsSchema = z.object({ id });
export const scrumDocumentQuerySchema = z.object({ version: z.string().regex(/^[1-9][0-9]{0,4}$/).optional() });
/** One Markdown version. `integrity` says whether the file still matches the recorded hash. */
export const scrumDocumentContentSchema = z.strictObject({
  documentId: id,
  version: z.number().int().min(1),
  content: z.string().max(SCRUM_DOCUMENT_TEXT_LIMIT),
  integrity: z.enum(['ok', 'altered', 'missing']),
  path: text(1000),
});
export type ScrumDocumentContent = z.infer<typeof scrumDocumentContentSchema>;

/** The accountable human's decision on one exact version. */
export const scrumDocumentDecisionSchema = z.strictObject({
  expectedRevision: revision,
  version: z.number().int().min(1),
  decision: z.enum(['approve', 'revoke']),
});
export type ScrumDocumentDecision = z.infer<typeof scrumDocumentDecisionSchema>;

export const scrumArtifactParamsSchema = z.object({ id });
