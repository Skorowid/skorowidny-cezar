import { z } from 'zod';

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

export const scrumStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision,
  productGoal: text(5000),
  definitionOfDone: text(20_000),
  items: z.array(scrumItemSchema).max(1000),
  sprints: z.array(scrumSprintSchema).max(500),
  notes: z.array(scrumNoteSchema).max(5000),
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
