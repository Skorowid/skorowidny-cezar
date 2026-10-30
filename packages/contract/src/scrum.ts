import { z } from 'zod';
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
export const scrumChatOutcomeSchema = z.enum(['applied', 'refused', 'queued', 'queue-failed', 'forward-pending', 'forwarded', 'forward-failed', 'run-failed', 'question']);
/** Outcomes the conversation shows inline as cezar's own notices. */
export const SCRUM_CHAT_NOTICE_OUTCOMES: readonly ScrumChatOutcome[] = ['forward-pending', 'forwarded', 'forward-failed', 'run-failed', 'question'];
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
});
export type ScrumChatState = z.infer<typeof scrumChatStateSchema>;

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
  messages: z.array(scrumChatMessageSchema).max(400),
  truncated: z.boolean(),
  state: scrumStateSchema,
});
export type ScrumChatView = z.infer<typeof scrumChatViewSchema>;
