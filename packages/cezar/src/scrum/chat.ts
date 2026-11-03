import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SCRUM_APPROVABLE_DOCUMENT_KINDS, SCRUM_CHAT_LOG_LIMIT, SCRUM_KICKOFF_QUESTIONS, scrumDorStatusSchema, scrumKickoffQuestionIdSchema, scrumNoteKindSchema,
  type ScrumChatLogEntry, type ScrumChatMessage, type ScrumChatState, type ScrumItem, type ScrumProvenance, type ScrumSprint, type ScrumState, type ScrumTrace,
} from '@open-mercato/cezar-contract';
import type { RunEvent } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import {
  MAX_REQUESTS_PER_AUTHOR_MESSAGE, addWork, buildEstimate, emptyProduct, kickoffBlockers, latestVersion, newWork, planningProblems, requestsSince, settleKickoff, startKickoff,
} from './coordinator-state.ts';
import { createDocument, reviseDocument } from './documents.ts';
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
// The closing fence must start a line: a Markdown document inside a JSON string has its newlines
// escaped, so its own code fences never end the block.
const FENCE = /```cezar-scrum[^\n]*\n([\s\S]*?)(?:\n```[ \t]*(?=\n|$)|```\s*$)/g;

/** SCRUM-COORD-01: the one project-facing thread is always on this runner; its model is never named here. */
export const SCRUM_COORDINATOR_RUNNER = 'opencode' as const;

/** The chat thread's one-step workflow, pinned to OpenCode whatever the project's `quick-task` says. */
export const SCRUM_CHAT_WORKFLOW: WorkflowDef = {
  name: 'scrum-chat',
  description: 'Project product coordinator (SCRUM-COORD-01).',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Product coordinator', prompt: '{{task}}', runner: SCRUM_COORDINATOR_RUNNER }],
};

/**
 * Starts every message cezar itself puts into the coordinator's thread. Such a message is an
 * agent's output, so it never counts as the author's words: not for a quote, not in the conversation.
 */
export const SCRUM_INTERNAL_PREFIX = '[cezar internal';
const isInternal = (text: string) => text.startsWith(SCRUM_INTERNAL_PREFIX);

export function emptyChatState(): ScrumChatState {
  return { threadRunId: null, threads: [], cursor: null, messageIds: [], log: [] };
}

export function chatSystemPrompt(): string {
  const questions = SCRUM_KICKOFF_QUESTIONS.map(question => `- ${question.id}${question.essential ? ' (essential)' : ''} — ${question.topic}: ${question.question}`).join('\n');
  return `You are the product coordinator of this one project, working inside the cezar cockpit: an AI assistant to the human author, who stays the accountable Product Owner. The author talks only to you. You gather the vision and the author's own objectives, prepare requirements as versioned Markdown, split approved work, plan within agreed limits, and report what other agents return. cezar applies your operations, runs other agents as real tasks and hands their persisted results back to you.

## Your memory
- At the start of EVERY turn read \`.ai/cezar/scrum/INDEX.md\`: the compact index of the product, gate, Sprints, documents, agent work and backlog. If it is missing read \`.ai/cezar/scrum/state.json\`.
- Open only what the turn needs: \`.ai/cezar/scrum/items/<id>.md\` for one item, \`.ai/cezar/scrum/documents/<id>/vNNN.md\` for one document version. \`chat.log\` in state.json holds the results of your operations, including refusals and their reasons.
- These files are the memory, not your recollection: other people edit them, and a long conversation may be resumed in a new session.
- Read nothing outside this project. Never read other projects, home-directory secrets or credentials.
- Never write files, change code, run builds or commit. You are read-only; everything changes only through the operations below.

## Rules you must follow
- Never invent business requirements, rules, acceptance criteria, data, permissions, priorities, profitability metrics, revenue figures or targets. Record only what the author stated or explicitly confirmed. A suggestion of yours is a proposal: label it as one and ask. When a business constraint is missing, ask; never fill in a default.
- If the author's statements conflict (with each other or with recorded decisions), do not merge or pick; describe the conflict and ask.
- Messages that start with "${SCRUM_INTERNAL_PREFIX}" come from cezar and carry other agents' results. They are not the author's words: never quote them as a decision and never treat an agent's recommendation as approved. Tell the author what matters in them: progress, blockers, review verdicts, gaps, and the decisions you need.

## First decomposition: the initial readiness gate
Before the first split of a new project into backlog items, ask these questions (group them; several per message is fine) and record each answer with \`answerKickoff\`. Essential ones must be answered; the others may be deferred only when the author says so.
${questions}
Then record the statements (\`setVision\`, \`setValueObjectives\`, \`setProductGoal\`, \`setDefinitionOfReady\`, \`setDefinitionOfDone\`, \`setPlanningConstraints\` when the author agrees limits) and prepare a minimum BRD and FRD in Markdown with \`addDocument\`.
- A BRD needs the headings: Identity, Purpose, Scope, Users and context, Requirements, Decisions and gaps.
- An FRD needs the headings: Identity and scope, Actors and behavior, Data and business rules, Failures and constraints, Acceptance and decisions.
- Write unknowns as open questions in the document, never as made-up content. Keep the documents minimum and right-sized; they grow per slice.
cezar refuses \`addItem\` until the gate is passed: every question handled, these statements set, and the author approved one complete BRD and FRD. INDEX.md lists what is still open. An existing backlog without the gate keeps working: then ask only what new work is missing.

## Iterative refinement
After the gate, refine one slice at a time: only the next ready slice needs detail, unrelated work must not wait for it. Assess each item against the author's Definition of Ready. Status READY only when nothing blocking is open; NEEDS CLARIFICATION with concrete \`questions\` when details are missing; BLOCKED for a critical conflict or dependency; CHANGE REQUEST when it changes an approved baseline.
- Split complex stories into small, cohesive, independently verifiable items that each deliver something a person can check. Respect dependencies (\`dependencies\`) and give related items one \`group\`. Do not cut work into arbitrary technical fragments, and do not add scope the author did not ask for.
- Record traceability: \`traces\` names the document and version an item comes from. Keep user stories (\`kind: story\`) and decisions (\`kind: decision\`) as documents linked to their items.
- Revising a document creates a new version that is not approved. Items tracing an older version are blocked until the new version is approved and you update their \`traces\`; that also withdraws the item's approval.

## Human approval
- Only the author approves. Use \`approveDocument\` (naming the exact version) and \`approveItem\` only after the author explicitly approved it in clear words; on an ambiguous answer ask again. The author can also approve a document in the cockpit.
- You never mark work Done and never change delivery status or Done evidence; a human does that after review. A review verdict from an agent is input, not acceptance.

## Other agents
Consultants, implementers and reviewers are real, separate tasks on the runners and models the author configured.
- \`requestConsultation\` asks one read-only agent about requirements gaps or feasibility, before you ask the author or finalize a document. At most ${MAX_REQUESTS_PER_AUTHOR_MESSAGE} consultations or reviews may start per author message; agents do not debate endlessly, and an unresolved question goes to the author.
- An item that is READY, approved, has acceptance criteria, no open questions, finished dependencies, a Product Goal and a Definition of Done, an intact document baseline and a place in the active Sprint with a Sprint Goal is queued automatically for a free agent. Tell the author which of these are still missing.
- A settled attempt with a branch gets an independent review automatically (when enabled), and \`requestReview\` asks for one more. Results come back to you as cezar's messages.
- Never claim a screenshot, file or preview exists unless the result lists it as verified or reachable.
- You may change an item whose execution run is still queued, running or waiting: cezar forwards the updated item to that run instead of restarting it. \`chat.log\` shows \`forward-pending\` while the change is recorded but NOT yet received (held, or waiting in the run's queued prompt), \`forwarded\` once it is confirmed in the run's transcript or the prompt the run started with, and \`forward-failed\` when it will not reach that run; never tell the author the agent received a change before \`chat.log\` shows \`forwarded\`. Changing the description or criteria of an approved item withdraws approval, and the run is told not to implement the change until approval is recorded again.
- A failed attempt is never retried by itself. When \`chat.log\` shows \`run-failed\`, tell the author which task failed and ask whether to try again. Only when the author then explicitly asks for another attempt, emit \`retryItem\` quoting that instruction; one instruction allows one attempt. Never retry on your own initiative, and never for a review's "changes" verdict without the author's decision.

## Sprints and estimates
- You may plan Sprint Goals and dates by yourself with \`planSprint\`, only inside the constraints the author agreed (\`setPlanningConstraints\`); cezar refuses anything outside them, and activates a Sprint only if the author allowed it. With no agreed constraints ask for them. You may also use \`addSprint\`/\`updateSprint\` when the author names the dates. When an item becomes READY with no Sprint named and you did not plan it, cezar plans it into the single active Sprint; if \`chat.log\` holds a \`question\` that no Sprint is active, plan one within the constraints or ask.
- Sprint Goals must serve the Product Goal. Selecting work for a Sprint is a forecast, not a promise, and it does not approve anything.
- Estimate items with \`estimateItem\`: your base estimate of working time in minutes. cezar stores it with a buffered estimate of exactly three times the base. Always describe both as uncertain forecasts, never as commitments or deadlines.

## Replying
Answer in plain prose and ask your questions in the message itself. Do not use CEZ:ASK or CEZ:DONE markers or a question tool. Never describe a change as made before \`chat.log\` confirms it was applied.

## Operations
To change anything, end your message with exactly one fenced block, the closing fence on its own line:

\`\`\`${SCRUM_CHAT_FENCE}
{"ops": [ ... ]}
\`\`\`

Most operations need a \`quote\`: a short VERBATIM excerpt of the author's own message in this conversation that the change is based on (copy it exactly; cezar refuses an operation whose quote it cannot find in the author's messages). A quote is optional only on the operations marked (no quote needed), which carry no decision. Use full ids from INDEX.md; a \`ref\` you choose names something created in the same block.
- {"op":"setVision","value":"…","quote":"…"}
- {"op":"setValueObjectives","objectives":[{"statement":"…","metric":"","target":""}],"quote":"…"} (only what the author defined; empty metric and target when not named)
- {"op":"answerKickoff","questionId":"vision","status":"answered","answer":"…","quote":"…"} (status "deferred" only for a non-essential question the author deferred)
- {"op":"setProductGoal","value":"…","quote":"…"}
- {"op":"setDefinitionOfReady","value":"…","quote":"…"}
- {"op":"setDefinitionOfDone","value":"…","quote":"…"}
- {"op":"setGuidelines","value":"…","quote":"…"}
- {"op":"setPlanningConstraints","maxSprintDays":14,"earliestStart":"YYYY-MM-DD","latestEnd":null,"mayActivate":false,"notes":"…","quote":"…"} / {"op":"clearPlanningConstraints","quote":"…"} (every value from the author; the numbers shown are placeholders)
- {"op":"addDocument","ref":"d","kind":"brd","title":"…","content":"# Markdown…","summary":"…","itemIds":[]} (no quote needed; kinds brd, frd, story, decision; it is a draft until approved)
- {"op":"reviseDocument","id":"<id or ref>","content":"…","summary":"what changed","title":"…","itemIds":[]} (no quote needed; a new unapproved version)
- {"op":"approveDocument","id":"<id or ref>","version":1,"quote":"<the author's explicit approval>"}
- {"op":"addItem","ref":"a","title":"…","description":"…","acceptanceCriteria":["…"],"questions":["…"],"dorStatus":"NEEDS CLARIFICATION","priority":1,"dependencies":["<id or ref>"],"group":"…","traces":[{"documentId":"<id or ref>","section":"…"}],"quote":"…"}
- {"op":"updateItem","id":"<id or ref>","title":"…","description":"…","acceptanceCriteria":["…"],"questions":["…"],"dorStatus":"READY","priority":2,"dependencies":["…"],"group":"…","traces":[…],"quote":"…"} (only the fields that change; a trace without a version means the latest)
- {"op":"approveItem","id":"<id or ref>","quote":"<the author's explicit approval>"}
- {"op":"estimateItem","id":"<id or ref>","baseMinutes":120,"rationale":"…"} (no quote needed)
- {"op":"requestConsultation","itemId":"<id, ref or null>","documentId":"<id, ref or null>","question":"…"} (no quote needed)
- {"op":"requestReview","id":"<item id or ref>"} (no quote needed)
- {"op":"planSprint","ref":"s1","id":"<id of a planned Sprint to change, optional>","name":"…","goal":"…","startsOn":"YYYY-MM-DD","endsOn":"YYYY-MM-DD","activate":false,"itemIds":["<id or ref>"]} (no quote needed; only inside the agreed constraints)
- {"op":"addSprint","ref":"s1","name":"…","goal":"…","startsOn":"YYYY-MM-DD","endsOn":"YYYY-MM-DD","status":"planned","quote":"…"} (status "planned" or "active"; at most one month long; one active Sprint)
- {"op":"updateSprint","id":"<id or ref>","name":"…","goal":"…","startsOn":"…","endsOn":"…","status":"active","quote":"…"}
- {"op":"planItem","sprintId":"<id or ref>","itemId":"<id or ref>","quote":"…"} / {"op":"unplanItem",…same fields…}
- {"op":"retryItem","id":"<id>","quote":"<the author's explicit retry instruction, given after the failure>"}
- {"op":"addNote","kind":"decision","body":"…","itemId":null,"sprintId":null,"quote":"…"} (kinds: general, planning, daily, review, retrospective, refinement, decision, question)

DoR statuses: READY, NEEDS CLARIFICATION, BLOCKED, CHANGE REQUEST. Omit the block when nothing changes.`;
}

const quote = z.string().trim().min(1).max(2000);
const ref = z.string().trim().min(1).max(64);
const lines = z.array(z.string().max(2000)).max(200);
const priority = z.number().int().min(1).max(1_000_000);
const title = z.string().trim().min(1).max(300);
/** Operations that carry no decision of the author: drafts only a human approval gives force to, forecasts and agent requests. */
const noDecisionQuote = quote.optional();
const traceInput = z.object({ documentId: ref, version: z.number().int().min(1).optional(), section: z.string().max(200).optional() });

export const chatOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setProductGoal'), quote, value: z.string().max(5000) }),
  z.object({ op: z.literal('setDefinitionOfDone'), quote, value: z.string().max(20_000) }),
  z.object({ op: z.literal('setGuidelines'), quote, value: z.string().max(20_000) }),
  z.object({
    op: z.literal('addItem'), quote, ref: ref.optional(), title, description: z.string().max(20_000).default(''),
    acceptanceCriteria: lines.default([]), questions: lines.default([]), dorStatus: scrumDorStatusSchema.default('NEEDS CLARIFICATION'),
    priority: priority.optional(), dependencies: z.array(ref).max(500).default([]), group: z.string().max(200).optional(),
    traces: z.array(traceInput).max(50).optional(),
  }),
  z.object({
    op: z.literal('updateItem'), quote, id: ref, title: title.optional(), description: z.string().max(20_000).optional(),
    acceptanceCriteria: lines.optional(), questions: lines.optional(), dorStatus: scrumDorStatusSchema.optional(),
    priority: priority.optional(), dependencies: z.array(ref).max(500).optional(), group: z.string().max(200).optional(),
    traces: z.array(traceInput).max(50).optional(),
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
  z.object({ op: z.literal('setVision'), quote, value: z.string().max(10_000) }),
  z.object({
    op: z.literal('setValueObjectives'), quote,
    objectives: z.array(z.object({ statement: z.string().trim().min(1).max(2000), metric: z.string().max(500).default(''), target: z.string().max(500).default('') })).max(50),
  }),
  z.object({ op: z.literal('setDefinitionOfReady'), quote, value: z.string().max(20_000) }),
  z.object({
    op: z.literal('setPlanningConstraints'), quote, maxSprintDays: z.number().int().min(1).max(31), earliestStart: z.iso.date(),
    latestEnd: z.iso.date().nullable().default(null), mayActivate: z.boolean(), notes: z.string().max(2000).default(''),
  }),
  z.object({ op: z.literal('clearPlanningConstraints'), quote }),
  z.object({ op: z.literal('answerKickoff'), quote, questionId: scrumKickoffQuestionIdSchema, status: z.enum(['answered', 'deferred']).default('answered'), answer: z.string().max(5000).default('') }),
  z.object({
    op: z.literal('addDocument'), quote: noDecisionQuote, ref: ref.optional(), kind: z.enum(['brd', 'frd', 'story', 'decision']), title,
    content: z.string(), summary: z.string().max(500).default(''), itemIds: z.array(ref).max(500).default([]),
  }),
  z.object({
    op: z.literal('reviseDocument'), quote: noDecisionQuote, id: ref, content: z.string(), summary: z.string().max(500).default(''),
    title: title.optional(), itemIds: z.array(ref).max(500).optional(),
  }),
  z.object({ op: z.literal('approveDocument'), quote, id: ref, version: z.number().int().min(1) }),
  z.object({ op: z.literal('estimateItem'), quote: noDecisionQuote, id: ref, baseMinutes: z.number().int().min(1).max(1_000_000), rationale: z.string().max(2000).default('') }),
  z.object({ op: z.literal('requestConsultation'), quote: noDecisionQuote, itemId: ref.nullable().default(null), documentId: ref.nullable().default(null), question: z.string().trim().min(1).max(4000) }),
  z.object({ op: z.literal('requestReview'), quote: noDecisionQuote, id: ref }),
  z.object({
    op: z.literal('planSprint'), quote: noDecisionQuote, ref: ref.optional(), id: ref.optional(), name: title, goal: z.string().max(5000),
    startsOn: z.iso.date(), endsOn: z.iso.date(), activate: z.boolean().default(false), itemIds: z.array(ref).max(1000).default([]),
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
  const said = [{ text: task, at: startedAt }, ...events.filter(event => event.type === 'user-message').map(event => ({ text: textOf(event), at: event.ts }))];
  return said.filter(message => !isInternal(message.text));
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
  /** Where document versions are written. */
  dataDir: string;
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

type Outcome = { detail: string; itemId?: string; sprintId?: string; plannedItemIds?: readonly string[] };
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
    const quoted = operation.quote ?? '';
    const cited = normalize(quoted);
    // A quote is checked whenever one is given, so an operation can never lean on words nobody said.
    if (quoted && !said.some(text => text.text.includes(cited))) {
      log.push(entry(ctx, operation.op, 'refused', 'the quote was not found in the user\'s messages', quoted));
      continue;
    }
    if (operation.op === 'retryItem') {
      // Q2: consent to a retry must come after the attempt it retries, so an old "try again" is never reused.
      const after = ctx.lastAttemptAt(refs.get(operation.id) ?? operation.id);
      if (after && !said.some(text => text.at > after && text.text.includes(cited))) {
        log.push(entry(ctx, operation.op, 'refused', 'the retry instruction must be a message sent after the last attempt', quoted));
        continue;
      }
    }
    const provenance: ScrumProvenance = { runId: ctx.runId, turnSeq: ctx.turnSeq, quote: quoted.slice(0, 2000), at: ctx.at };
    const scratch = new Map(refs);
    try {
      const { state: next, outcome } = applyOne(current, operation, provenance, scratch, ctx);
      const before = new Set(stateProblems(current));
      const introduced = stateProblems(next).filter(problem => !before.has(problem));
      if (introduced.length) refuse(introduced.join('; '));
      track(result, current, next, operation, outcome, ctx);
      current = settleKickoff(next);
      for (const [name, id] of scratch) refs.set(name, id);
      log.push(entry(ctx, operation.op, 'applied', outcome.detail, quoted, outcome.itemId, outcome.sprintId));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      log.push(entry(ctx, operation.op, 'refused', error.message, quoted));
    }
  }
  return { ...result, state: appendLog(current, log) };
}

/** Record what an applied operation means for the follow-up policies (Q1, Q4). */
function track(result: Omit<ChatTurnResult, 'state'>, before: ScrumState, after: ScrumState, operation: ChatOp, outcome: Outcome, ctx: ApplyContext): void {
  for (const planned of outcome.plannedItemIds ?? []) {
    result.plannedExplicitly.add(planned);
    if (ctx.busyItemIds.has(planned)) result.changedBusy.set(planned, [...(result.changedBusy.get(planned) ?? []), ...(operation.quote ? [operation.quote] : [])]);
  }
  const id = outcome.itemId;
  if (!id) return;
  if (operation.op === 'planItem' || operation.op === 'unplanItem') result.plannedExplicitly.add(id);
  const previous = before.items.find(item => item.id === id);
  const next = after.items.find(item => item.id === id);
  if (next?.dorStatus === 'READY' && previous?.dorStatus !== 'READY') {
    result.becameReady.set(id, { runId: ctx.runId, turnSeq: ctx.turnSeq, quote: (operation.quote ?? '').slice(0, 2000), at: ctx.at });
  }
  const changes = operation.op === 'updateItem' || operation.op === 'approveItem' || operation.op === 'planItem' || operation.op === 'unplanItem';
  if (changes && ctx.busyItemIds.has(id)) result.changedBusy.set(id, [...(result.changedBusy.get(id) ?? []), operation.quote ?? '']);
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
  const documentOf = (value: string) => {
    const resolved = refs.get(value) ?? value;
    return (state.documents ?? []).find(document => document.id === resolved) ?? refuse(`unknown document ${value}`);
  };
  const traces = (inputs: readonly { documentId: string; version?: number; section?: string }[]): ScrumTrace[] => inputs.map(input => {
    const document = documentOf(input.documentId);
    const version = input.version ?? latestVersion(document).version;
    if (!document.versions.some(entry => entry.version === version)) refuse(`${document.code} has no version ${version}`);
    return { documentId: document.id, version, ...(input.section?.trim() ? { section: input.section.trim() } : {}) };
  });
  const storing = <T>(write: () => T): T => {
    try { return write(); } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
  };
  const product = () => state.product ?? emptyProduct();

  switch (operation.op) {
    case 'setProductGoal':
      return { state: { ...state, productGoal: operation.value }, outcome: { detail: 'Product Goal set' } };
    case 'setDefinitionOfDone':
      return { state: { ...state, definitionOfDone: operation.value }, outcome: { detail: 'Definition of Done set' } };
    case 'setGuidelines':
      return { state: { ...state, guidelines: operation.value }, outcome: { detail: 'guidelines set' } };
    case 'addItem': {
      // Real gate, not an instruction: no first decomposition before the author approved the minimum BRD and FRD.
      const gate = kickoffBlockers(state);
      if (gate.length) refuse(`the first decomposition waits for the initial readiness gate: ${gate.join('; ')}`);
      const id = randomUUID();
      const dependencies = operation.dependencies.map(itemId);
      const traced = traces(operation.traces ?? []);
      remember(operation.ref, id);
      const group = operation.group?.trim();
      const item: ScrumItem = {
        id, title: operation.title, description: operation.description, acceptanceCriteria: operation.acceptanceCriteria,
        dorStatus: operation.dorStatus, approved: false, questions: operation.questions,
        priority: operation.priority ?? Math.max(0, ...state.items.map(entry => entry.priority)) + 1,
        dependencies, deliveryStatus: 'open', doneEvidence: '', runIds: [],
        ...(group ? { group } : {}),
        ...(traced.length ? { traces: traced } : {}),
        autoQueue: true, provenance: [provenance],
      };
      return { state: { ...state, items: [...state.items, item] }, outcome: { detail: `added "${item.title}"`, itemId: id } };
    }
    case 'updateItem': {
      const id = itemId(operation.id);
      const before = editable(id);
      const traced = operation.traces ? traces(operation.traces) : undefined;
      const requirementsChanged = (operation.description !== undefined && operation.description !== before.description)
        || (operation.acceptanceCriteria !== undefined && operation.acceptanceCriteria.join('\n') !== before.acceptanceCriteria.join('\n'))
        || (traced !== undefined && JSON.stringify(traced) !== JSON.stringify(before.traces ?? []));
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
          ...(traced !== undefined ? { traces: traced } : {}),
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
    case 'setVision':
      return { state: { ...state, product: { ...product(), vision: operation.value } }, outcome: { detail: 'vision recorded' } };
    case 'setValueObjectives': {
      const valueObjectives = operation.objectives.map(objective => ({ id: randomUUID(), statement: objective.statement, metric: objective.metric, target: objective.target, provenance }));
      return { state: { ...state, product: { ...product(), valueObjectives } }, outcome: { detail: `${valueObjectives.length} value objectives recorded as the author defined them` } };
    }
    case 'setDefinitionOfReady':
      return { state: { ...state, product: { ...product(), definitionOfReady: operation.value } }, outcome: { detail: 'Definition of Ready set' } };
    case 'setPlanningConstraints': {
      if (operation.latestEnd && operation.latestEnd < operation.earliestStart) refuse('latestEnd is before earliestStart');
      const planning = {
        maxSprintDays: operation.maxSprintDays, earliestStart: operation.earliestStart, latestEnd: operation.latestEnd,
        mayActivate: operation.mayActivate, notes: operation.notes, provenance,
      };
      return { state: { ...state, product: { ...product(), planning } }, outcome: { detail: 'Sprint planning constraints agreed' } };
    }
    case 'clearPlanningConstraints':
      return { state: { ...state, product: { ...product(), planning: null } }, outcome: { detail: 'Sprint planning constraints withdrawn; the coordinator cannot plan Sprints by itself' } };
    case 'answerKickoff': {
      const question = SCRUM_KICKOFF_QUESTIONS.find(entry => entry.id === operation.questionId);
      if (operation.status === 'deferred' && question?.essential) refuse(`"${question.topic}" is essential: it needs an answer before the first decomposition`);
      if (operation.status === 'answered' && !operation.answer.trim()) refuse('an answered question needs the answer');
      const started = startKickoff(state);
      const kickoff = started.kickoff!;
      const answers = [
        ...kickoff.answers.filter(answer => answer.questionId !== operation.questionId),
        { questionId: operation.questionId, status: operation.status, answer: operation.answer, provenance },
      ];
      return { state: { ...started, kickoff: { ...kickoff, answers } }, outcome: { detail: `initial question "${question?.topic ?? operation.questionId}" ${operation.status}` } };
    }
    case 'addDocument': {
      const itemIds = operation.itemIds.map(itemId);
      const created = storing(() => createDocument(ctx.dataDir, state, {
        kind: operation.kind, title: operation.title, itemIds, content: operation.content, summary: operation.summary,
        source: 'coordinator', provenance: operation.quote ? provenance : null, runId: ctx.runId,
      }));
      remember(operation.ref, created.document.id);
      return { state: created.state, outcome: { detail: `${created.document.code} v1 "${created.document.title}" drafted; it needs the author's approval` } };
    }
    case 'reviseDocument': {
      const before = documentOf(operation.id);
      if (!SCRUM_APPROVABLE_DOCUMENT_KINDS.includes(before.kind)) refuse(`${before.code} is generated by cezar and cannot be revised`);
      const itemIds = operation.itemIds?.map(itemId);
      const revised = storing(() => reviseDocument(ctx.dataDir, state, before.id, {
        content: operation.content, summary: operation.summary, source: 'coordinator', provenance: operation.quote ? provenance : null, runId: ctx.runId,
        ...(operation.title !== undefined ? { title: operation.title } : {}),
        ...(itemIds !== undefined ? { itemIds } : {}),
      }));
      const latest = latestVersion(revised.document).version;
      return {
        state: revised.state,
        outcome: { detail: revised.changed ? `${before.code} is now v${latest}; this version needs the author's approval` : `${before.code} is unchanged` },
      };
    }
    case 'approveDocument': {
      const before = documentOf(operation.id);
      if (!SCRUM_APPROVABLE_DOCUMENT_KINDS.includes(before.kind)) refuse(`${before.code} is not a requirement or decision to approve`);
      const latest = latestVersion(before).version;
      if (operation.version !== latest) refuse(`${before.code} is at v${latest}; the approval named v${operation.version}`);
      const approval = { version: latest, by: 'chat' as const, at: ctx.at, provenance };
      return {
        state: { ...state, documents: (state.documents ?? []).map(document => document.id === before.id ? { ...document, approval } : document) },
        outcome: { detail: `${before.code} v${latest} approved by the author` },
      };
    }
    case 'estimateItem': {
      const id = itemId(operation.id);
      const before = editable(id);
      const estimate = buildEstimate(operation.baseMinutes, operation.rationale, ctx.at, ctx.runId);
      return {
        state: { ...state, items: state.items.map(item => item.id === id ? { ...item, estimate } : item) },
        outcome: { detail: `"${before.title}" estimated: base ${estimate.baseMinutes} min, ×3 buffered ${estimate.bufferedMinutes} min (uncertain forecast)`, itemId: id },
      };
    }
    case 'requestConsultation':
    case 'requestReview': {
      const lastAuthorAt = ctx.userTexts.reduce<string | undefined>((latest, message) => latest === undefined || message.at > latest ? message.at : latest, undefined);
      if (requestsSince(state, lastAuthorAt) >= MAX_REQUESTS_PER_AUTHOR_MESSAGE) refuse(`at most ${MAX_REQUESTS_PER_AUTHOR_MESSAGE} consultations or reviews may start per author message; ask the author instead`);
      const origin = operation.quote ? provenance : null;
      if (operation.op === 'requestReview') {
        const id = itemId(operation.id);
        const before = state.items.find(item => item.id === id)!;
        const target = before.runIds.at(-1) ?? refuse(`"${before.title}" has no attempt to review`);
        return {
          state: addWork(state, newWork('review', { itemId: id, targetRunId: target, request: `Review the latest attempt of "${before.title}"`, provenance: origin })),
          outcome: { detail: `review of "${before.title}" requested`, itemId: id },
        };
      }
      const consultedItem = operation.itemId === null ? null : itemId(operation.itemId);
      const consultedDocument = operation.documentId === null ? null : documentOf(operation.documentId).id;
      return {
        state: addWork(state, newWork('consult', { itemId: consultedItem, documentId: consultedDocument, request: operation.question, provenance: origin })),
        outcome: { detail: 'consultation requested', ...(consultedItem ? { itemId: consultedItem } : {}) },
      };
    }
    case 'planSprint': {
      const existing = operation.id ? state.sprints.find(sprint => sprint.id === (refs.get(operation.id!) ?? operation.id)) ?? refuse(`unknown Sprint ${operation.id}`) : undefined;
      if (existing && existing.status !== 'planned') refuse(`Sprint "${existing.name}" is ${existing.status}; only a planned Sprint can be replanned`);
      const id = existing?.id ?? randomUUID();
      const problems = planningProblems(state, { id, startsOn: operation.startsOn, endsOn: operation.endsOn, goal: operation.goal }, operation.activate);
      if (problems.length) refuse(`outside the agreed constraints: ${problems.join('; ')}`);
      remember(operation.ref, id);
      const planned = operation.itemIds.map(value => { const planId = itemId(value); editable(planId); return planId; });
      // The authority is the author's agreed constraints: cite those words, not the coordinator's.
      const authority: ScrumProvenance = { ...provenance, quote: (state.product?.planning?.provenance.quote ?? '').slice(0, 2000) };
      const fields = { name: operation.name, goal: operation.goal, startsOn: operation.startsOn, endsOn: operation.endsOn, status: operation.activate ? 'active' as const : 'planned' as const };
      const sprintsNext = existing
        ? sprints(id, sprint => ({ ...sprint, ...fields, itemIds: [...new Set([...sprint.itemIds, ...planned])] })).map(sprint => sprint.id === id ? { ...sprint, provenance: [...(sprint.provenance ?? []).slice(0, -1), authority] } : sprint)
        : [...state.sprints, { id, ...fields, itemIds: [...new Set(planned)], provenance: [authority] }];
      return {
        state: { ...state, sprints: sprintsNext },
        outcome: { detail: `Sprint "${operation.name}" ${existing ? 'replanned' : 'planned'} within the agreed constraints (${operation.startsOn} – ${operation.endsOn})${operation.activate ? ' and activated' : ''}`, sprintId: id, plannedItemIds: planned },
      };
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
      // cezar's own hand-over of agent results: the conversation shows its notice, not this text.
      if (!isInternal(textOf(event))) messages.push({ seq: event.seq, role: 'user', text: textOf(event), at: event.ts });
    } else if (event.type === 'text') {
      agent = agent ? { ...agent, text: `${agent.text}\n${textOf(event)}` } : { seq: event.seq, role: 'agent', text: textOf(event), at: event.ts };
    } else if (event.type === 'turn-end') flush();
  }
  flush();
  return messages;
}
