import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SCRUM_CHAT_LOG_LIMIT, scrumDorStatusSchema, scrumNoteKindSchema,
  type ScrumChatLogEntry, type ScrumChatMessage, type ScrumChatState, type ScrumItem, type ScrumProvenance, type ScrumSprint, type ScrumState,
} from '@open-mercato/cezar-contract';
import type { RunEvent } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { implementationBlockers, stateProblems } from './validate.ts';

/**
 * SCRUM-CHAT-01 (docs/skorowidny-cezar/scrum-chat.md): the project's Scrum chat is a real agent
 * run. Its turns may end with a fenced `cezar-scrum` JSON block of backlog operations; this
 * module turns the run's persisted transcript into those operations and applies them to the
 * Scrum state. Every operation must cite the user's own words, which are checked against the
 * thread's user messages, so nothing reaches the backlog without a traceable chat decision.
 *
 * @author Skorowid
 */

export const SCRUM_CHAT_FENCE = 'cezar-scrum';
const FENCE = /```cezar-scrum[^\n]*\n([\s\S]*?)```/g;

/** The chat thread's one-step workflow, pinned to Codex whatever the project's `quick-task` says. */
export const SCRUM_CHAT_WORKFLOW: WorkflowDef = {
  name: 'scrum-chat',
  description: 'Project Scrum chat (SCRUM-CHAT-01).',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Scrum chat', prompt: '{{task}}', runner: 'codex' }],
};

export function emptyChatState(): ScrumChatState {
  return { threadRunId: null, threads: [], cursor: null, messageIds: [], log: [] };
}

export function chatSystemPrompt(): string {
  return `You are the Scrum assistant of this one project, working inside the cezar cockpit. The project creator talks to you to describe problems, intended work, acceptance criteria, guidelines and Sprints. You maintain the project's local Product Backlog through backlog operations; cezar applies them and queues every task that becomes executable for an execution agent automatically.

## Reading the backlog
- At the start of EVERY turn read \`.ai/cezar/scrum/state.json\` in the current directory. It is the current Product Backlog, Sprints, notes, Definition of Done, guidelines and \`chat.log\` (the result of your previous operations, including refusals and their reasons). Other people may have edited it since your last turn.
- Read nothing outside this project. Never read other projects, home-directory secrets or credentials.
- Never write files, change code, run builds or commit. You are read-only; the backlog changes only through the operations below.

## Rules you must follow
- Do not invent business requirements, rules, acceptance criteria, data, permissions or priorities. Record only what the user stated or explicitly confirmed. A suggestion of yours is a proposal: label it as one and ask.
- Before a task can be executable, ask the user for anything essential that is missing: the Definition of Done, acceptance criteria, the expected behaviour, failure handling, dependencies. Keep such a task at DoR status NEEDS CLARIFICATION with the questions in its \`questions\` list.
- Split complex work into small, independently verifiable tasks and give related tasks the same \`group\` label. Splitting must not add scope the user did not ask for.
- Mark an item approved (\`approveItem\`) only after the user explicitly approved its requirements in clear words. If the answer is ambiguous, ask again; never infer consent.
- When the user names the Sprint for an item, plan it there (\`planItem\`). When an item becomes READY and the user named no Sprint, do not plan it yourself: cezar plans it into the single active Sprint. If \`chat.log\` holds a \`question\` that no Sprint is active, ask the user which Sprint the item belongs to.
- Create a Sprint or make a Sprint active only when the user explicitly asked for it. Do not choose Sprint dates the user did not give.
- If the user's statements conflict (with each other or with recorded decisions), do not merge or pick; describe the conflict and ask.
- You never mark work Done and never change delivery status or Done evidence; a human does that after review.
- You may change an item whose execution run is still queued, running or waiting: cezar forwards the updated item to that run instead of restarting it. \`chat.log\` shows \`forwarded\` when the run received it and \`forward-failed\` when it did not; never tell the user the agent received a change before \`chat.log\` confirms it. Changing the description or criteria of an approved item still withdraws approval, and the run is told not to implement the change until approval is recorded again.
- A failed automatic attempt is never retried by itself. When \`chat.log\` shows \`run-failed\`, tell the user which task failed and ask whether to try again. Only when the user then explicitly asks for another attempt, emit \`retryItem\` quoting that instruction; one instruction allows one attempt. Never retry on your own initiative.
- An item is queued automatically when it is READY, approved, has acceptance criteria, no open questions, finished dependencies, a Product Goal and a Definition of Done exist, and it is planned in the active Sprint that has a Sprint Goal. Tell the user which of these are still missing.
- Answer in plain prose. Ask your questions in the message itself. Do not use CEZ:ASK or CEZ:DONE markers.

## Backlog operations
To change the backlog, end your message with exactly one fenced block:

\`\`\`${SCRUM_CHAT_FENCE}
{"ops": [ ... ]}
\`\`\`

Each operation is a JSON object with an \`op\` field and a \`quote\` field: a short VERBATIM excerpt of the user's own message in this conversation that this change is based on (copy it exactly; cezar refuses an operation whose quote it cannot find in the user's messages). Use full ids from state.json; a \`ref\` you choose names an item or Sprint created in the same block.
- {"op":"setProductGoal","value":"…","quote":"…"}
- {"op":"setDefinitionOfDone","value":"…","quote":"…"}
- {"op":"setGuidelines","value":"…","quote":"…"}
- {"op":"addItem","ref":"a","title":"…","description":"…","acceptanceCriteria":["…"],"questions":["…"],"dorStatus":"NEEDS CLARIFICATION","priority":1,"dependencies":["<id or ref>"],"group":"…","quote":"…"}
- {"op":"updateItem","id":"<id or ref>","title":"…","description":"…","acceptanceCriteria":["…"],"questions":["…"],"dorStatus":"READY","priority":2,"dependencies":["…"],"group":"…","quote":"…"} (only the fields that change; changing the description or criteria of an approved item withdraws its approval)
- {"op":"approveItem","id":"<id or ref>","quote":"<the user's explicit approval>"}
- {"op":"addSprint","ref":"s1","name":"…","goal":"…","startsOn":"YYYY-MM-DD","endsOn":"YYYY-MM-DD","status":"planned","quote":"…"} (status "planned" or "active"; at most one month long; one active Sprint)
- {"op":"updateSprint","id":"<id or ref>","name":"…","goal":"…","startsOn":"…","endsOn":"…","status":"active","quote":"…"}
- {"op":"planItem","sprintId":"<id or ref>","itemId":"<id or ref>","quote":"…"} / {"op":"unplanItem",…same fields…}
- {"op":"retryItem","id":"<id>","quote":"<the user's explicit retry instruction, given after the failure>"}
- {"op":"addNote","kind":"decision","body":"…","itemId":null,"sprintId":null,"quote":"…"} (kinds: general, planning, daily, review, retrospective, refinement, decision, question)

DoR statuses: READY, NEEDS CLARIFICATION, BLOCKED, CHANGE REQUEST. Omit the block when nothing changes. Never describe a change as made before \`chat.log\` confirms it was applied.`;
}

const quote = z.string().trim().min(1).max(2000);
const ref = z.string().trim().min(1).max(64);
const lines = z.array(z.string().max(2000)).max(200);
const priority = z.number().int().min(1).max(1_000_000);
const title = z.string().trim().min(1).max(300);

export const chatOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setProductGoal'), quote, value: z.string().max(5000) }),
  z.object({ op: z.literal('setDefinitionOfDone'), quote, value: z.string().max(20_000) }),
  z.object({ op: z.literal('setGuidelines'), quote, value: z.string().max(20_000) }),
  z.object({
    op: z.literal('addItem'), quote, ref: ref.optional(), title, description: z.string().max(20_000).default(''),
    acceptanceCriteria: lines.default([]), questions: lines.default([]), dorStatus: scrumDorStatusSchema.default('NEEDS CLARIFICATION'),
    priority: priority.optional(), dependencies: z.array(ref).max(500).default([]), group: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal('updateItem'), quote, id: ref, title: title.optional(), description: z.string().max(20_000).optional(),
    acceptanceCriteria: lines.optional(), questions: lines.optional(), dorStatus: scrumDorStatusSchema.optional(),
    priority: priority.optional(), dependencies: z.array(ref).max(500).optional(), group: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal('approveItem'), quote, id: ref }),
  z.object({ op: z.literal('retryItem'), quote, id: ref }),
  z.object({
    op: z.literal('addSprint'), quote, ref: ref.optional(), name: title, goal: z.string().max(5000).default(''),
    startsOn: z.iso.date(), endsOn: z.iso.date(), status: z.enum(['planned', 'active']).default('planned'),
  }),
  z.object({
    op: z.literal('updateSprint'), quote, id: ref, name: title.optional(), goal: z.string().max(5000).optional(),
    startsOn: z.iso.date().optional(), endsOn: z.iso.date().optional(), status: z.enum(['planned', 'active', 'closed', 'cancelled']).optional(),
  }),
  z.object({ op: z.literal('planItem'), quote, sprintId: ref, itemId: ref }),
  z.object({ op: z.literal('unplanItem'), quote, sprintId: ref, itemId: ref }),
  z.object({
    op: z.literal('addNote'), quote, kind: scrumNoteKindSchema.default('decision'), body: z.string().trim().min(1).max(20_000),
    itemId: ref.nullable().default(null), sprintId: ref.nullable().default(null),
  }),
]);
export type ChatOp = z.infer<typeof chatOpSchema>;

/** One agent turn of the chat thread, closed by its persisted `turn-end` event. */
export interface ChatTurn {
  seq: number;
  at: string;
  /** Text events of the turn, in order. Delta backends may split a line across events. */
  texts: string[];
}

const textOf = (event: RunEvent) => typeof event.text === 'string' ? event.text : '';

/** Agent turns that ended after `afterSeq`. */
export function turnsAfter(events: readonly RunEvent[], afterSeq: number): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let texts: string[] = [];
  for (const event of events) {
    if (event.type === 'user-message') texts = [];
    else if (event.type === 'text') texts.push(textOf(event));
    else if (event.type === 'turn-end') {
      if (event.seq > afterSeq) turns.push({ seq: event.seq, at: event.ts, texts });
      texts = [];
    }
  }
  return turns;
}

/** One thing the user said in the thread, and when. */
export interface UserText { text: string; at: string }

/** Everything the user said in this thread: the opening task plus every user message. */
export function userTexts(task: string, startedAt: string, events: readonly RunEvent[]): UserText[] {
  return [{ text: task, at: startedAt }, ...events.filter(event => event.type === 'user-message').map(event => ({ text: textOf(event), at: event.ts }))];
}

/** The operation blocks of one turn. Chunks are tried joined by newline, then joined directly. */
export function parseTurnOps(turn: ChatTurn): { ops: ChatOp[]; problems: string[] } {
  for (const joined of [turn.texts.join('\n'), turn.texts.join('')]) {
    const blocks = [...joined.matchAll(FENCE)].map(match => match[1] ?? '');
    if (!blocks.length) continue;
    const ops: ChatOp[] = [];
    const problems: string[] = [];
    let parsedAll = true;
    for (const block of blocks) {
      let json: unknown;
      try { json = JSON.parse(block); } catch { parsedAll = false; break; }
      const list = z.object({ ops: z.array(z.unknown()).max(200) }).safeParse(json);
      if (!list.success) { problems.push('the operation block has no "ops" array'); continue; }
      list.data.ops.forEach((raw, index) => {
        const parsed = chatOpSchema.safeParse(raw);
        if (parsed.success) ops.push(parsed.data);
        else problems.push(`operation ${index + 1}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'op'} ${issue.message}`).join(', ')}`);
      });
    }
    if (parsedAll) return { ops, problems };
  }
  const mentioned = turn.texts.join('').includes('```' + SCRUM_CHAT_FENCE);
  return { ops: [], problems: mentioned ? ['the operation block is not valid JSON; nothing was applied'] : [] };
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

export interface ApplyContext {
  runId: string;
  turnSeq: number;
  at: string;
  userTexts: readonly UserText[];
  /** Items whose execution run is still queued, running or waiting. */
  busyItemIds: ReadonlySet<string>;
  /** When the item's latest attempt ended (or started, if it has not ended): a retry must be asked for after it. */
  lastAttemptAt(itemId: string): string | undefined;
}

/** A turn's applied state plus what the follow-up policies need from it. */
export interface ChatTurnResult {
  state: ScrumState;
  /** Q1: busy items this turn changed, with the user's words behind each change. */
  changedBusy: Map<string, string[]>;
  /** Q4: items this turn made READY (created READY or moved to READY). */
  becameReady: Map<string, ScrumProvenance>;
  /** Q4: items this turn planned or unplanned explicitly; never re-planned by the policy. */
  plannedExplicitly: Set<string>;
}

type Outcome = { detail: string; itemId?: string; sprintId?: string };
class Refusal extends Error {}
const refuse = (reason: string): never => { throw new Refusal(reason); };

/**
 * Apply one turn's operations in order. Each operation is all-or-nothing: one that cites no
 * user words, changes a Done item or leaves the state invalid is refused and logged, and the
 * next one still runs against the state as it was.
 */
export function applyChatOps(state: ScrumState, ops: readonly ChatOp[], problems: readonly string[], ctx: ApplyContext): ChatTurnResult {
  const said = ctx.userTexts.map(message => ({ text: normalize(message.text), at: message.at }));
  const refs = new Map<string, string>();
  const log: ScrumChatLogEntry[] = problems.map(problem => entry(ctx, 'parse', 'refused', problem, ''));
  const result: Omit<ChatTurnResult, 'state'> = { changedBusy: new Map(), becameReady: new Map(), plannedExplicitly: new Set() };
  let current = state;
  for (const operation of ops) {
    const cited = normalize(operation.quote);
    if (!said.some(text => text.text.includes(cited))) {
      log.push(entry(ctx, operation.op, 'refused', 'the quote was not found in the user\'s messages', operation.quote));
      continue;
    }
    if (operation.op === 'retryItem') {
      // Q2: consent to a retry must come after the attempt it retries, so an old "try again" is never reused.
      const after = ctx.lastAttemptAt(refs.get(operation.id) ?? operation.id);
      if (after && !said.some(text => text.at > after && text.text.includes(cited))) {
        log.push(entry(ctx, operation.op, 'refused', 'the retry instruction must be a message sent after the last attempt', operation.quote));
        continue;
      }
    }
    const provenance: ScrumProvenance = { runId: ctx.runId, turnSeq: ctx.turnSeq, quote: operation.quote.slice(0, 2000), at: ctx.at };
    const scratch = new Map(refs);
    try {
      const { state: next, outcome } = applyOne(current, operation, provenance, scratch, ctx);
      const before = new Set(stateProblems(current));
      const introduced = stateProblems(next).filter(problem => !before.has(problem));
      if (introduced.length) refuse(introduced.join('; '));
      track(result, current, next, operation, outcome, ctx);
      current = next;
      for (const [name, id] of scratch) refs.set(name, id);
      log.push(entry(ctx, operation.op, 'applied', outcome.detail, operation.quote, outcome.itemId, outcome.sprintId));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      log.push(entry(ctx, operation.op, 'refused', error.message, operation.quote));
    }
  }
  return { ...result, state: appendLog(current, log) };
}

/** Record what an applied operation means for the follow-up policies (Q1, Q4). */
function track(result: Omit<ChatTurnResult, 'state'>, before: ScrumState, after: ScrumState, operation: ChatOp, outcome: Outcome, ctx: ApplyContext): void {
  const id = outcome.itemId;
  if (!id) return;
  if (operation.op === 'planItem' || operation.op === 'unplanItem') result.plannedExplicitly.add(id);
  const previous = before.items.find(item => item.id === id);
  const next = after.items.find(item => item.id === id);
  if (next?.dorStatus === 'READY' && previous?.dorStatus !== 'READY') {
    result.becameReady.set(id, { runId: ctx.runId, turnSeq: ctx.turnSeq, quote: operation.quote.slice(0, 2000), at: ctx.at });
  }
  const changes = operation.op === 'updateItem' || operation.op === 'approveItem' || operation.op === 'planItem' || operation.op === 'unplanItem';
  if (changes && ctx.busyItemIds.has(id)) result.changedBusy.set(id, [...(result.changedBusy.get(id) ?? []), operation.quote]);
}

export function appendLog(state: ScrumState, log: readonly ScrumChatLogEntry[]): ScrumState {
  if (!log.length) return state;
  const chat = state.chat ?? emptyChatState();
  return { ...state, chat: { ...chat, log: [...chat.log, ...log].slice(-SCRUM_CHAT_LOG_LIMIT) } };
}

export function entry(
  ctx: { runId: string | null; turnSeq: number }, op: string, outcome: ScrumChatLogEntry['outcome'], detail: string, cited: string,
  itemId?: string, sprintId?: string,
): ScrumChatLogEntry {
  return {
    at: new Date().toISOString(), runId: ctx.runId, turnSeq: ctx.turnSeq, op: op.slice(0, 40), outcome,
    detail: detail.slice(0, 2000), quote: cited.slice(0, 2000), itemId: itemId ?? null, sprintId: sprintId ?? null,
  };
}

const withProvenance = <T extends { provenance?: ScrumProvenance[] }>(value: T, provenance: ScrumProvenance): T =>
  ({ ...value, provenance: [...(value.provenance ?? []), provenance].slice(-200) });

function applyOne(
  state: ScrumState, operation: ChatOp, provenance: ScrumProvenance, refs: Map<string, string>, ctx: ApplyContext,
): { state: ScrumState; outcome: Outcome } {
  const itemId = (value: string) => {
    const resolved = refs.get(value) ?? value;
    return state.items.some(item => item.id === resolved) ? resolved : refuse(`unknown item ${value}`);
  };
  const sprintId = (value: string) => {
    const resolved = refs.get(value) ?? value;
    return state.sprints.some(sprint => sprint.id === resolved) ? resolved : refuse(`unknown Sprint ${value}`);
  };
  // Q1: an item with an active run stays editable; the change is forwarded to that run afterwards.
  const editable = (id: string): ScrumItem => {
    const item = state.items.find(entry => entry.id === id) ?? refuse(`unknown item ${id}`);
    if (item.deliveryStatus === 'done') refuse(`"${item.title}" is Done; it cannot be changed from the chat`);
    return item;
  };
  const items = (id: string, change: (item: ScrumItem) => ScrumItem) =>
    state.items.map(item => item.id === id ? withProvenance(change(item), provenance) : item);
  const sprints = (id: string, change: (sprint: ScrumSprint) => ScrumSprint) =>
    state.sprints.map(sprint => sprint.id === id ? withProvenance(change(sprint), provenance) : sprint);
  const remember = (name: string | undefined, id: string) => {
    if (!name) return;
    if (refs.has(name)) refuse(`ref "${name}" is used twice in one block`);
    refs.set(name, id);
  };

  switch (operation.op) {
    case 'setProductGoal':
      return { state: { ...state, productGoal: operation.value }, outcome: { detail: 'Product Goal set' } };
    case 'setDefinitionOfDone':
      return { state: { ...state, definitionOfDone: operation.value }, outcome: { detail: 'Definition of Done set' } };
    case 'setGuidelines':
      return { state: { ...state, guidelines: operation.value }, outcome: { detail: 'guidelines set' } };
    case 'addItem': {
      const id = randomUUID();
      const dependencies = operation.dependencies.map(itemId);
      remember(operation.ref, id);
      const group = operation.group?.trim();
      const item: ScrumItem = {
        id, title: operation.title, description: operation.description, acceptanceCriteria: operation.acceptanceCriteria,
        dorStatus: operation.dorStatus, approved: false, questions: operation.questions,
        priority: operation.priority ?? Math.max(0, ...state.items.map(entry => entry.priority)) + 1,
        dependencies, deliveryStatus: 'open', doneEvidence: '', runIds: [],
        ...(group ? { group } : {}),
        autoQueue: true, provenance: [provenance],
      };
      return { state: { ...state, items: [...state.items, item] }, outcome: { detail: `added "${item.title}"`, itemId: id } };
    }
    case 'updateItem': {
      const id = itemId(operation.id);
      const before = editable(id);
      const requirementsChanged = (operation.description !== undefined && operation.description !== before.description)
        || (operation.acceptanceCriteria !== undefined && operation.acceptanceCriteria.join('\n') !== before.acceptanceCriteria.join('\n'));
      const dependencies = operation.dependencies?.map(itemId);
      const group = operation.group?.trim();
      const next = items(id, item => {
        const { group: _previous, ...rest } = item;
        return {
          ...(operation.group !== undefined ? rest : item),
          ...(group ? { group } : {}),
          ...(operation.title !== undefined ? { title: operation.title } : {}),
          ...(operation.description !== undefined ? { description: operation.description } : {}),
          ...(operation.acceptanceCriteria !== undefined ? { acceptanceCriteria: operation.acceptanceCriteria } : {}),
          ...(operation.questions !== undefined ? { questions: operation.questions } : {}),
          ...(operation.dorStatus !== undefined ? { dorStatus: operation.dorStatus } : {}),
          ...(operation.priority !== undefined ? { priority: operation.priority } : {}),
          ...(dependencies !== undefined ? { dependencies } : {}),
          // A changed approved baseline needs a fresh approval (CHANGE REQUEST rule).
          ...(requirementsChanged ? { approved: false } : {}),
        };
      });
      const detail = `updated "${before.title}"${requirementsChanged && before.approved ? '; requirements changed, so approval was withdrawn' : ''}`;
      return { state: { ...state, items: next }, outcome: { detail, itemId: id } };
    }
    case 'approveItem': {
      const id = itemId(operation.id);
      const before = editable(id);
      return { state: { ...state, items: items(id, item => ({ ...item, approved: true })) }, outcome: { detail: `requirements of "${before.title}" approved`, itemId: id } };
    }
    case 'retryItem': {
      const id = itemId(operation.id);
      const before = editable(id);
      if (ctx.busyItemIds.has(id)) refuse(`"${before.title}" still has an active run; another attempt can start only after it settles`);
      if (!before.runIds.length) refuse(`"${before.title}" has no previous attempt to retry`);
      const blockers = implementationBlockers(state, before);
      if (blockers.length) refuse(`"${before.title}" is not ready for another attempt: ${blockers.join('; ')}`);
      return {
        state: { ...state, items: items(id, item => ({ ...item, autoRetry: provenance })) },
        outcome: { detail: `another attempt of "${before.title}" requested; it is queued when an agent is free`, itemId: id },
      };
    }
    case 'addSprint': {
      const id = randomUUID();
      remember(operation.ref, id);
      const sprint: ScrumSprint = {
        id, name: operation.name, goal: operation.goal, startsOn: operation.startsOn, endsOn: operation.endsOn,
        status: operation.status, itemIds: [], provenance: [provenance],
      };
      return { state: { ...state, sprints: [...state.sprints, sprint] }, outcome: { detail: `Sprint "${sprint.name}" created (${sprint.status})`, sprintId: id } };
    }
    case 'updateSprint': {
      const id = sprintId(operation.id);
      const next = sprints(id, sprint => ({
        ...sprint,
        ...(operation.name !== undefined ? { name: operation.name } : {}),
        ...(operation.goal !== undefined ? { goal: operation.goal } : {}),
        ...(operation.startsOn !== undefined ? { startsOn: operation.startsOn } : {}),
        ...(operation.endsOn !== undefined ? { endsOn: operation.endsOn } : {}),
        ...(operation.status !== undefined ? { status: operation.status } : {}),
      }));
      return { state: { ...state, sprints: next }, outcome: { detail: 'Sprint updated', sprintId: id } };
    }
    case 'planItem':
    case 'unplanItem': {
      const sprint = sprintId(operation.sprintId);
      const item = itemId(operation.itemId);
      editable(item);
      const plan = operation.op === 'planItem';
      const next = sprints(sprint, entry => ({
        ...entry,
        itemIds: plan ? (entry.itemIds.includes(item) ? entry.itemIds : [...entry.itemIds, item]) : entry.itemIds.filter(value => value !== item),
      }));
      return { state: { ...state, sprints: next }, outcome: { detail: plan ? 'planned into the Sprint' : 'removed from the Sprint plan', itemId: item, sprintId: sprint } };
    }
    case 'addNote': {
      const note = {
        id: randomUUID(), kind: operation.kind, body: operation.body,
        itemId: operation.itemId === null ? null : itemId(operation.itemId),
        sprintId: operation.sprintId === null ? null : sprintId(operation.sprintId),
        createdAt: new Date().toISOString(),
      };
      return {
        state: { ...state, notes: [...state.notes, note] },
        outcome: { detail: `${note.kind} note added`, ...(note.itemId ? { itemId: note.itemId } : {}), ...(note.sprintId ? { sprintId: note.sprintId } : {}) },
      };
    }
  }
}

/** The conversation for the cockpit: user messages and agent turns, operation blocks folded away. */
export function chatMessages(task: string, startedAt: string, events: readonly RunEvent[]): ScrumChatMessage[] {
  const messages: ScrumChatMessage[] = [{ seq: 0, role: 'user', text: task, at: startedAt }];
  let agent: ScrumChatMessage | undefined;
  const flush = () => {
    const text = agent?.text.replace(FENCE, '_(backlog operations — results are in the change log)_').trim();
    if (agent && text) messages.push({ ...agent, text });
    agent = undefined;
  };
  for (const event of events) {
    if (event.type === 'user-message') {
      flush();
      messages.push({ seq: event.seq, role: 'user', text: textOf(event), at: event.ts });
    } else if (event.type === 'text') {
      agent = agent ? { ...agent, text: `${agent.text}\n${textOf(event)}` } : { seq: event.seq, role: 'agent', text: textOf(event), at: event.ts };
    } else if (event.type === 'turn-end') flush();
  }
  flush();
  return messages;
}
