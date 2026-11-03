import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SCRUM_INBOX_LIMIT,
  type ScrumChatLogEntry, type ScrumInboxEntry, type ScrumItem, type ScrumState, type ScrumWork, type ScrumWorkResult, type ScrumWorkStatus,
} from '@open-mercato/cezar-contract';
import type { RunEvent, RunRecord, RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { queuedStackRefusal } from '../workflows/queued-bounds.ts';
import { captureArtifacts } from './artifacts.ts';
import { ACTIVE_RUN_STATUSES, type ScrumLauncher } from './autoqueue.ts';
import { SCRUM_COORDINATOR_RUNNER, SCRUM_INTERNAL_PREFIX, appendLog, emptyChatState, entry, turnsAfter, type ChatTurn } from './chat.ts';
import { buildContextPacket } from './context.ts';
import { AUTOMATIC_REVIEW, addWork, coordinatorConfig, latestVersion, newWork } from './coordinator-state.ts';
import { buildIndex, createDocument, documentVersionPath, readDocumentVersion, reviseDocument } from './documents.ts';
import { SCRUM_RESULT_FENCE, buildScrumPrompt, itemContext, resultInstructions } from './prompt.ts';

/**
 * SCRUM-COORD-01 agent collaboration. A consultation, an implementation attempt or a review is a
 * real run of the existing engine, tracked by one `state.work` entry. When the run settles (or
 * parks) its result is read from its PERSISTED transcript, stored as a Markdown document and put
 * into a durable inbox; a separate pass hands it to the coordinator's thread and confirms it in
 * that transcript. Same discipline as the forward outbox: durable first, confirmed by marker, a
 * crash between hand-over and save is reconciled without a second delivery.
 *
 * @author Skorowid
 */

const WORK_MARKER = 'Scrum agent work id:';
export const scrumWorkMarker = (workId: string) => `${WORK_MARKER} ${workId}`;
const resultMarker = (entryId: string) => `Scrum result id: ${entryId}`;
const MESSAGE_LIMIT = 100_000;

function consultPrompt(dataDir: string, state: ScrumState, work: ScrumWork): string {
  const item = state.items.find(entry => entry.id === work.itemId);
  const document = (state.documents ?? []).find(entry => entry.id === work.documentId);
  const read = document ? readDocumentVersion(dataDir, document) : undefined;
  return [
    `Requirements consultation for the project's coordinator: ${work.request}`.slice(0, 2000),
    `## The question\n${work.request}`,
    item ? `${itemContext(state, item)}\n\n${buildContextPacket(dataDir, state, item)}` : `## Project index\n${buildIndex(state)}`,
    ...(document && read ? [`## Document ${document.code} v${read.version}: ${document.title}\n${read.integrity === 'ok' ? read.content : `(the file is ${read.integrity}; report this)`}`] : []),
    scrumWorkMarker(work.id),
    '## Instructions\n- This is read-only analysis: do not change code, files or the backlog.\n- Identify requirement gaps, conflicts and untestable criteria, and assess technical feasibility against the repository.\n- Do not invent business rules. A suggestion is a proposal, labelled as one. You never approve anything; the human author decides through the coordinator.',
    resultInstructions('"gaps":["each gap as a concrete question, marked BLOCKING or NON-BLOCKING"],"blockers":["what prevents this"],"feasibility":"your assessment and the risks you saw in the code"'),
  ].join('\n\n');
}

function reviewPrompt(dataDir: string, state: ScrumState, work: ScrumWork, target: RunRecord, item: ScrumItem | undefined): string {
  return [
    `Independent review of the attempt for "${item?.title ?? 'a Scrum item'}".`,
    ...(item ? [itemContext(state, item), buildContextPacket(dataDir, state, item)] : []),
    `## What to review\nBranch \`${target.branch}\`${target.baseBranch ? ` against base \`${target.baseBranch}\`` : ''} (attempt run ${target.id}).\nThis is your own isolated worktree. Run \`git checkout --detach ${target.branch}\` and read the diff from its fork point.`,
    scrumWorkMarker(work.id),
    '## Instructions\n- You did not write this work; try to falsify it. Check every acceptance criterion, the Definition of Done, anything outside the requirements, and every claim against the diff. Run the checks the repository provides when you can, and report what you ran and what it printed.\n- Do not fix anything, commit, merge or push. A reviewer that edits is no longer a reviewer.\n- Your verdict is advice to the coordinator and the human author. It does not accept the work or mark it Done.',
    resultInstructions('"verdict":"approve | changes | reject","gaps":["findings with file and line"],"blockers":["what stopped the review"],"artifacts":[]'),
  ].join('\n\n');
}

/** Start every recorded assignment that has no run yet, on its configured agent. Runs under the Scrum lock. */
export async function startPendingWork(state: ScrumState, store: RunStore, launch: ScrumLauncher, dataDir: string): Promise<ScrumState> {
  let current = state;
  const log: ScrumChatLogEntry[] = [];
  const at = { runId: null, turnSeq: 0 };
  const update = (id: string, change: Partial<ScrumWork>) => {
    current = { ...current, work: (current.work ?? []).map(work => work.id === id ? { ...work, ...change, updatedAt: new Date().toISOString() } : work) };
  };
  for (const work of state.work ?? []) {
    if (work.status !== 'pending' || work.runId) continue;
    const item = current.items.find(entry => entry.id === work.itemId);
    let target: RunRecord | undefined;
    if (work.kind === 'review') {
      target = work.targetRunId ? store.getRun(work.targetRunId) : undefined;
      if (!target?.branch) {
        update(work.id, { status: 'failed', detail: 'the attempt under review has no branch to read' });
        continue;
      }
      if (work.branch !== target.branch) update(work.id, { branch: target.branch });
    }
    // A run started before a crash could not record itself: adopt it instead of starting another.
    const marker = scrumWorkMarker(work.id);
    let runId = store.listRuns().find(run => run.task.includes(marker))?.id;
    if (!runId) {
      const prompt = work.kind === 'review' && target ? reviewPrompt(dataDir, current, work, target, item) : consultPrompt(dataDir, current, work);
      const config = coordinatorConfig(current);
      try {
        runId = (await launch(prompt, { readOnly: work.kind === 'consult', agent: work.kind === 'review' ? config.agents.review : config.agents.consult })).id;
      } catch (error) {
        const detail = `could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
        // Told once per reason; it stays pending and is tried again on the next pass.
        if (work.detail !== detail) {
          update(work.id, { detail });
          log.push(entry(at, work.kind, 'agent-result', `The ${work.kind} agent ${detail}. Nothing is running for this request; it is tried again on the next pass.`, '', work.itemId ?? undefined));
        }
        continue;
      }
    }
    const run = store.getRun(runId);
    update(work.id, { runId, status: 'active', detail: '', runner: run?.runner ?? null, model: run?.model ?? null });
    log.push(entry(at, work.kind, 'agent-started', `${agentLabel(work.kind)} started on ${run?.runner ?? 'the default runner'}${run?.model ? ` (${run.model})` : ''} as run ${runId.slice(0, 8)}${item ? ` for "${item.title}"` : ''}.`, '', work.itemId ?? undefined));
  }
  return appendLog(current, log);
}

const agentLabel = (kind: ScrumWork['kind']) => ({ consult: 'A consultation agent', implement: 'An implementation agent', review: 'A review agent' })[kind];

const resultBlockSchema = z.object({
  summary: z.string().max(100_000).default(''),
  verdict: z.enum(['approve', 'changes', 'reject']).nullable().optional(),
  gaps: z.array(z.string()).max(1000).default([]),
  blockers: z.array(z.string()).max(1000).default([]),
  feasibility: z.string().max(100_000).default(''),
  artifacts: z.array(z.unknown()).max(1000).default([]),
});
type ResultBlock = z.infer<typeof resultBlockSchema>;
const RESULT_FENCE = new RegExp('```' + SCRUM_RESULT_FENCE + '[^\\n]*\\n([\\s\\S]*?)(?:\\n```[ \\t]*(?=\\n|$)|```\\s*$)', 'g');

/** The result block of a turn, if it parses. Chunks are tried joined by newline, then directly. */
function parseResult(turn: ChatTurn): ResultBlock | undefined {
  for (const joined of [turn.texts.join('\n'), turn.texts.join('')]) {
    const blocks = [...joined.matchAll(RESULT_FENCE)].map(match => match[1] ?? '');
    const block = blocks[blocks.length - 1];
    if (block === undefined) continue;
    try {
      const parsed = resultBlockSchema.safeParse(JSON.parse(block));
      if (parsed.success) return parsed.data;
    } catch {
      // Delta backends may split a line across events; the other join may parse.
    }
  }
  return undefined;
}

const finalText = (turn: ChatTurn | undefined) => turn ? turn.texts.join('\n').replace(RESULT_FENCE, '').trim() : '';
const lastTurnWithText = (events: readonly RunEvent[]): ChatTurn | undefined => {
  const turns = turnsAfter(events, 0).filter(turn => turn.texts.some(text => text.trim()));
  return turns[turns.length - 1];
};
const statusFor = (run: RunRecord, structured: boolean): ScrumWorkStatus => {
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'waiting') return structured ? 'completed' : 'waiting';
  return 'completed';
};
const DOCUMENT_KIND = { consult: 'consultation', implement: 'implementation', review: 'review' } as const;
const DOCUMENT_TITLE = { consult: 'Consultation', implement: 'Implementation result', review: 'Review' } as const;
const bullet = (values: readonly string[]) => values.map(value => `- ${value}`).join('\n');

function resultMarkdown(work: ScrumWork, run: RunRecord, status: ScrumWorkStatus, block: ResultBlock | undefined, text: string): string {
  return [
    `# ${DOCUMENT_TITLE[work.kind]}: ${work.request}`.slice(0, 500),
    `- Status: ${status} (run status ${run.status})\n- Run: ${run.id}\n- Agent: ${run.runner ?? 'default'}${run.model ? ` / ${run.model}` : ''}\n- Branch: ${run.branch ?? 'none'}\n- Written from the run's persisted transcript by cezar. This is an agent's output, not an approved decision.`,
    ...(block?.verdict ? [`## Verdict\n${block.verdict}`] : []),
    ...(block?.summary.trim() ? [`## Summary\n${block.summary.trim()}`] : []),
    ...(block?.gaps.length ? [`## Gaps\n${bullet(block.gaps)}`] : []),
    ...(block?.blockers.length ? [`## Blockers\n${bullet(block.blockers)}`] : []),
    ...(block?.feasibility.trim() ? [`## Feasibility\n${block.feasibility.trim()}`] : []),
    ...(run.error?.trim() ? [`## Run error\n${run.error.trim()}`] : []),
    `## Final message\n${text || '(the agent wrote no final text)'}`,
  ].join('\n\n').slice(0, 190_000);
}

function inboxText(state: ScrumState, work: ScrumWork, entryId: string, dataDir: string): string {
  const item = state.items.find(entry => entry.id === work.itemId);
  const result = work.result;
  const document = (state.documents ?? []).find(entry => entry.id === result?.documentId);
  const artifacts = work.artifacts.map(artifact => `- ${artifact.kind} "${artifact.label || artifact.declared}": ${artifact.status} — ${artifact.reason}`);
  const clip = (values: readonly string[]) => values.map(value => `- ${value.slice(0, 500)}`).slice(0, 30).join('\n');
  return [
    resultMarker(entryId),
    `${DOCUMENT_TITLE[work.kind]}${item ? ` of "${item.title}"` : ''} (work ${work.id}, run ${work.runId ?? 'none'}, ${work.runner ?? 'default runner'}${work.model ? ` / ${work.model}` : ''}): ${work.status}${result?.verdict ? `, verdict ${result.verdict}` : ''}${result?.source === 'transcript' ? ' (no structured result block; final text only)' : ''}${result?.source === 'none' ? ' (the run returned no text)' : ''}.`,
    `Request: ${work.request.slice(0, 500)}`,
    ...(work.detail ? [`Note: ${work.detail.slice(0, 500)}`] : []),
    ...(result?.summary ? [`Summary: ${result.summary.slice(0, 3000)}`] : []),
    ...(result?.gaps.length ? [`Gaps:\n${clip(result.gaps)}`] : []),
    ...(result?.blockers.length ? [`Blockers:\n${clip(result.blockers)}`] : []),
    ...(result?.feasibility ? [`Feasibility: ${result.feasibility.slice(0, 1500)}`] : []),
    ...(artifacts.length ? [`Presented results, as cezar verified them:\n${artifacts.join('\n')}`] : []),
    ...(document && result?.documentVersion ? [`Full result: ${document.code} v${result.documentVersion}, ${documentVersionPath(dataDir, document, result.documentVersion)}`] : []),
  ].join('\n').slice(0, 12_000);
}

/**
 * Bring every open assignment up to date with its run, and report each new result once. Nothing
 * here starts a retry or changes an item's delivery status: only the author decides those.
 */
export async function syncWork(state: ScrumState, store: RunStore, dataDir: string): Promise<ScrumState> {
  let current = state;
  const log: ScrumChatLogEntry[] = [];
  const at = { runId: null, turnSeq: 0 };
  for (const original of state.work ?? []) {
    if (original.status === 'pending' && !original.runId) {
      // A review that could not get a branch is settled by `startPendingWork`; nothing to read yet.
      continue;
    }
    const run = original.runId ? store.getRun(original.runId) : undefined;
    const stale = !!original.runId && !run;
    // Settled and already reported: an inactive run has nothing more to say.
    const settled = !['pending', 'active', 'waiting'].includes(original.status);
    if (settled && original.reportedKey && (!run || !ACTIVE_RUN_STATUSES.has(run.status))) continue;
    if (run && (run.status === 'queued' || run.status === 'running')) {
      if (original.status !== 'active') current = patchWork(current, original.id, { status: 'active' });
      continue;
    }
    const inbox = current.chat?.inbox ?? [];
    // Past the limit it waits on its work entry and is reported by a later pass.
    if (inbox.length >= SCRUM_INBOX_LIMIT) continue;
    const events = run ? store.readEvents(run.id) : [];
    const turn = lastTurnWithText(events);
    const block = turn ? parseResult(turn) : undefined;
    const status: ScrumWorkStatus = run ? statusFor(run, block !== undefined) : 'failed';
    const seq = turn?.seq ?? 0;
    const key = `${status}:${seq}`;
    if (original.reportedKey === key) {
      // Resumed and settled again without a new turn: same result, only the status moved back.
      if (original.status !== status) current = patchWork(current, original.id, { status });
      continue;
    }
    const text = finalText(turn);
    let work = original;
    let artifacts = work.artifacts;
    if (run && block?.artifacts.length && (status === 'completed' || status === 'waiting')) {
      artifacts = await captureArtifacts(block.artifacts, run.worktreePath, dataDir, work.id, run.id);
    }
    let documentId = work.result?.documentId ?? null;
    let documentVersion = work.result?.documentVersion ?? null;
    let detail = stale ? 'the run is no longer in the run history' : work.detail;
    if (run) {
      try {
        const input = { content: resultMarkdown(work, run, status, block, text), summary: `${status}${block?.verdict ? `, verdict ${block.verdict}` : ''}`, source: 'agent' as const, provenance: null, runId: run.id };
        if (documentId) {
          const revised = reviseDocument(dataDir, current, documentId, input);
          current = revised.state;
          documentVersion = latestVersion(revised.document).version;
        } else {
          const created = createDocument(dataDir, current, { ...input, kind: DOCUMENT_KIND[work.kind], title: `${DOCUMENT_TITLE[work.kind]}: ${work.request}`.slice(0, 300), itemIds: work.itemId ? [work.itemId] : [] });
          current = created.state;
          documentId = created.document.id;
          documentVersion = 1;
        }
      } catch (error) {
        // The summary still reaches the coordinator; only the Markdown copy is lost, and it says so.
        detail = `the result could not be stored as a document: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
      }
    }
    const result: ScrumWorkResult = {
      source: block ? 'structured' : text ? 'transcript' : 'none',
      verdict: block?.verdict ?? null,
      summary: (block?.summary.trim() || text || (run?.error?.trim() ?? '')).slice(0, 4000),
      gaps: (block?.gaps ?? []).map(value => value.slice(0, 2000)).slice(0, 200),
      blockers: (block?.blockers ?? []).map(value => value.slice(0, 2000)).slice(0, 200),
      feasibility: (block?.feasibility ?? '').slice(0, 2000),
      documentId, documentVersion, seq, capturedAt: new Date().toISOString(),
    };
    work = {
      ...work, status, detail, result, artifacts, reportedKey: key, branch: run?.branch ?? work.branch,
      runner: run?.runner ?? work.runner, model: run?.model ?? work.model, updatedAt: new Date().toISOString(),
    };
    current = patchWork(current, work.id, work);
    const id = randomUUID();
    const chat = current.chat ?? emptyChatState();
    const inboxEntry: ScrumInboxEntry = { id, workId: work.id, text: inboxText(current, work, id, dataDir), createdAt: new Date().toISOString(), detail: 'recorded; not yet handed to the coordinator' };
    current = { ...current, chat: { ...chat, inbox: [...(chat.inbox ?? []), inboxEntry] } };
    const item = current.items.find(entry => entry.id === work.itemId);
    const of = item ? ` of "${item.title}"` : '';
    // A failed automatic attempt already has its `run-failed` notice (POL-2).
    if (!(work.kind === 'implement' && status === 'failed')) {
      log.push(entry(at, work.kind, 'agent-result', `${DOCUMENT_TITLE[work.kind]}${of} ${status === 'waiting' ? 'is waiting for an answer' : status}${result.verdict ? `: verdict ${result.verdict}` : ''}. The result was recorded for the coordinator.`, '', work.itemId ?? undefined));
    }
    if (work.kind === 'implement' && status === 'completed' && run?.branch && coordinatorConfig(current).autoReview
      && !(current.work ?? []).some(entry => entry.kind === 'review' && entry.targetRunId === run.id)) {
      current = addWork(current, newWork('review', { itemId: work.itemId, targetRunId: run.id, branch: run.branch, request: AUTOMATIC_REVIEW }));
    }
  }
  return appendLog(current, log);
}

function patchWork(state: ScrumState, id: string, change: Partial<ScrumWork>): ScrumState {
  return { ...state, work: (state.work ?? []).map(work => work.id === id ? { ...work, ...change, updatedAt: new Date().toISOString() } : work) };
}

export interface InboxEngine {
  dataDir: string;
  store: RunStore;
  manager: Pick<RunManager, 'sendMessage' | 'enqueueMessage' | 'continueRun'>;
  /** Why the coordinator's provider cannot take a message now; empty when it can. */
  runBlocked(run: RunRecord): Promise<string | null | undefined>;
}

/**
 * One delivery pass into the coordinator's thread. Everything sendable goes as ONE message, so a
 * batch of results costs one coordinator turn, and only between turns. An entry leaves the inbox
 * only when the coordinator ANSWERED it: its marker is in the transcript and the next thing after
 * it is a finished turn. A hand-over whose session then died is not delivery; it is sent again only
 * after the author's next message or in a new thread, so a broken provider cannot make this loop.
 */
export async function deliverInbox(state: ScrumState, engine: InboxEngine): Promise<{ state: ScrumState; unchanged: boolean }> {
  const chat = state.chat;
  const inbox = chat?.inbox ?? [];
  if (!chat || !inbox.length) return { state, unchanged: true };
  const thread = chat.threadRunId ? engine.store.getRun(chat.threadRunId) : undefined;
  const events = thread ? engine.store.readEvents(thread.id) : [];
  const stacked = thread?.queuedMessages?.map(message => message.text) ?? [];
  const answered = (item: ScrumInboxEntry): boolean => {
    const marker = resultMarker(item.id);
    if (stacked.some(text => text.includes(marker)) && thread?.status !== 'queued') return events.some(event => event.type === 'turn-end');
    let found = false;
    for (const event of events) {
      // Another message before a finished turn means that turn answered it, not this hand-over.
      if (event.type === 'user-message') found = typeof event.text === 'string' && event.text.includes(marker);
      else if (found && event.type === 'turn-end') return true;
    }
    return false;
  };
  const open = inbox.filter(item => !answered(item));
  const save = (kept: ScrumInboxEntry[]) => {
    const same = kept.length === inbox.length && kept.every((item, index) => item === inbox[index]);
    return { state: same ? state : { ...state, chat: { ...chat, inbox: kept } }, unchanged: same };
  };
  const hold = (detail: string, items: readonly ScrumInboxEntry[] = open) => {
    const held = new Set(items);
    return save(open.map(item => !held.has(item) || item.detail === detail ? item : { ...item, detail: detail.slice(0, 2000) }));
  };
  if (!open.length) return save([]);
  if (!thread) return hold('held: the coordinator has no conversation yet; it receives this after the author\'s next message');
  if (thread.runner !== SCRUM_COORDINATOR_RUNNER) return hold('held: the conversation is on an older runner; the next author message starts the coordinator on OpenCode');
  // Not into a running turn or a question the thread itself is parked on: it would be taken as the answer.
  if (thread.status === 'running') return hold('held: the coordinator is in the middle of a turn');
  if (thread.askParked) return hold('held: the coordinator is waiting for the author\'s answer');
  const authorSpokeAfter = (at: string) => events.some(event => event.type === 'user-message' && typeof event.text === 'string' && !event.text.startsWith(SCRUM_INTERNAL_PREFIX) && event.ts > at);
  const sendable = open.filter(item => !item.handedAt || item.handedRunId !== thread.id || authorSpokeAfter(item.handedAt));
  if (!sendable.length) {
    return hold(ACTIVE_RUN_STATUSES.has(thread.status)
      ? 'handed to the coordinator; waiting for its answer'
      : `handed over, but the coordinator's session ended (${thread.status}) before it answered; sent again after the author's next message`);
  }
  if (thread.status !== 'queued') {
    const blocked = await engine.runBlocked(thread).catch(error => String(error));
    if (blocked) return hold(`held: ${blocked}`, sendable);
  }
  const batch: ScrumInboxEntry[] = [];
  let size = 0;
  for (const item of sendable) {
    if (size + item.text.length > MESSAGE_LIMIT - 2000) break;
    batch.push(item);
    size += item.text.length;
  }
  const text = [
    `${SCRUM_INTERNAL_PREFIX} — results of other agents, not the author's words. Never cite them as the author's decision.]`,
    ...batch.map(item => item.text),
    'Tell the author what matters: progress, blockers, verdicts, gaps, and the decisions you need. An attempt is retried and work is approved or Done only on the author\'s word.',
  ].join('\n\n');
  const content = [{ type: 'text' as const, text }];
  const handed = () => {
    const at = new Date().toISOString();
    const sent = new Set(batch);
    return save(open.map(item => sent.has(item) ? { ...item, handedAt: at, handedRunId: thread.id, detail: 'handed to the coordinator; waiting for its answer' } : item));
  };
  if (engine.manager.sendMessage(thread.id, content)) return handed();
  if (thread.status === 'queued') {
    const refusal = queuedStackRefusal(engine.dataDir, thread, content, text);
    if (refusal) return hold(`held: the queued prompt cannot take it (${refusal})`, batch);
    if (engine.manager.enqueueMessage(thread.id, content)) return handed();
    return hold('held: the coordinator is starting', batch);
  }
  const resumed = engine.manager.continueRun(thread.id, { text });
  if (resumed.ok) return handed();
  return hold(`held: ${resumed.error ?? 'the thread cannot take a message right now'}; it is tried again on the next pass`, batch);
}

/** Exposed for the manual refinement button, which is one consultation like any other. */
export function refinementPrompt(state: ScrumState, item: ScrumItem, work: ScrumWork, packet: string): string {
  return `${buildScrumPrompt(state, item, 'refine', packet)}\n\n${scrumWorkMarker(work.id)}`;
}
