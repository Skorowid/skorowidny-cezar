import {
  SCRUM_FORWARD_LIMIT, SCRUM_FORWARD_TEXT_LIMIT,
  type ScrumChatLogEntry, type ScrumForward, type ScrumState,
} from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { queuedStackRefusal } from '../workflows/queued-bounds.ts';
import { ACTIVE_RUN_STATUSES } from './autoqueue.ts';
import { appendLog, emptyChatState, entry } from './chat.ts';
import { buildScrumChangeMessage, scrumChangeMarker } from './prompt.ts';

/**
 * SCRUM-CHAT-01 POL-1 delivery (docs/skorowidny-cezar/scrum-chat.md § Forwarding semantics).
 * An accepted chat change is first written to `chat.forwards` in the same save as the turn that
 * made it; delivery is a later pass under the Scrum lock that hands it to the engine through its
 * DURABLE rungs only — the live session (a transcript `user-message`) or the queued prompt
 * (`queuedMessages` in runs.json). The in-memory start-up buffer is never used. A rung that cannot
 * take it leaves the entry pending; nothing was handed over, so a later pass may try again.
 * Once handed over, the change id in the run's transcript or queued prompt decides the outcome,
 * so a crash between the hand-over and the save is reconciled without a second delivery.
 *
 * @author Skorowid
 */

export interface ForwardEngine {
  dataDir: string;
  store: RunStore;
  manager: Pick<RunManager, 'sendMessage' | 'enqueueMessage'>;
  /** Why the run's provider cannot take a message now; empty when it can. */
  runBlocked(run: RunRecord): Promise<string | null | undefined>;
}

type Origin = { runId: string; turnSeq: number };

const runLabel = (runId: string) => `run ${runId.slice(0, 8)}`;

/**
 * Record one turn's change of a busy item for each of its queued, running or waiting runs.
 * No engine call. A change already recorded for a run (a replayed turn) is not added twice.
 */
export function planForwards(state: ScrumState, store: RunStore, itemId: string, quotes: readonly string[], origin: Origin): ScrumState {
  const item = state.items.find(entry => entry.id === itemId);
  if (!item) return state;
  const changeId = `${origin.runId}:${origin.turnSeq}:${itemId}`;
  const quote = quotes.join(' / ').slice(0, 2000);
  const log = (outcome: ScrumChatLogEntry['outcome'], detail: string) => entry(origin, 'forward', outcome, detail, quote, itemId);
  const runs = item.runIds.map(id => store.getRun(id)).filter((run): run is RunRecord => run !== undefined && ACTIVE_RUN_STATUSES.has(run.status));
  if (!runs.length) {
    return appendLog(state, [log('forward-failed', `The change to "${item.title}" was not sent: its run settled first. The backlog holds the updated item for the next attempt.`)]);
  }
  const text = buildScrumChangeMessage(state, item, quotes, changeId);
  if (text.length > SCRUM_FORWARD_TEXT_LIMIT) {
    return appendLog(state, [log('forward-failed', `The change to "${item.title}" was NOT sent: the message restating the item is ${text.length} characters, over the ${SCRUM_FORWARD_TEXT_LIMIT}-character limit for one message, and cezar does not shorten requirements. The backlog holds the updated item; the running agent still works from the previous requirements.`)]);
  }
  const chat = state.chat ?? emptyChatState();
  const forwards = [...(chat.forwards ?? [])];
  const logged: ScrumChatLogEntry[] = [];
  for (const run of runs) {
    if (forwards.some(forward => forward.changeId === changeId && forward.runId === run.id)) continue;
    if (forwards.length >= SCRUM_FORWARD_LIMIT) {
      logged.push(log('forward-failed', `The change to "${item.title}" was NOT sent to ${runLabel(run.id)}: ${SCRUM_FORWARD_LIMIT} changes are already waiting for delivery. That agent still works from the previous requirements.`));
      continue;
    }
    forwards.push({
      changeId, itemId, runId: run.id, text, quote, origin, createdAt: new Date().toISOString(), status: 'pending',
      detail: 'recorded; not yet handed to the run',
    });
    logged.push(log('forward-pending', `The change to "${item.title}" was recorded for ${runLabel(run.id)} and is being delivered. The agent has NOT received it yet.`));
  }
  return appendLog({ ...state, chat: { ...chat, forwards } }, logged);
}

type Step =
  | { kind: 'keep'; status: ScrumForward['status']; detail: string; notice?: string }
  | { kind: 'done'; outcome: 'forwarded' | 'forward-failed'; detail: string };

/**
 * One delivery pass over the outbox. Changes for the same run go in the order they were made;
 * a held change holds the later ones for that run. `unchanged` when nothing moved.
 */
export async function deliverForwards(state: ScrumState, engine: ForwardEngine): Promise<{ state: ScrumState; unchanged: boolean }> {
  const chat = state.chat;
  const open = chat?.forwards ?? [];
  if (!chat || !open.length) return { state, unchanged: true };
  const kept: ScrumForward[] = [];
  const log: ScrumChatLogEntry[] = [];
  const held = new Set<string>();
  const transcripts = new Map<string, string[]>();
  let changed = false;
  for (const forward of open) {
    const title = state.items.find(item => item.id === forward.itemId)?.title ?? 'the item';
    const step: Step = held.has(forward.runId)
      ? { kind: 'keep', status: forward.status, detail: forward.status === 'queued' ? forward.detail : 'waiting for an earlier change to the same run' }
      : await deliverOne(forward, engine, transcripts);
    if (step.kind === 'done') {
      changed = true;
      log.push(entry(forward.origin, 'forward', step.outcome, `The change to "${title}" ${step.detail}`, forward.quote, forward.itemId));
      continue;
    }
    held.add(forward.runId);
    if (step.status !== forward.status || step.detail !== forward.detail) {
      changed = true;
      // A notice only when what the user should know changes, never on every pass.
      if (step.notice) log.push(entry(forward.origin, 'forward', 'forward-pending', `The change to "${title}" ${step.notice}`, forward.quote, forward.itemId));
    }
    kept.push({ ...forward, status: step.status, detail: step.detail });
  }
  if (!changed) return { state, unchanged: true };
  return { state: appendLog({ ...state, chat: { ...chat, forwards: kept } }, log), unchanged: false };
}

async function deliverOne(forward: ScrumForward, engine: ForwardEngine, transcripts: Map<string, string[]>): Promise<Step> {
  const label = runLabel(forward.runId);
  const marker = scrumChangeMarker(forward.changeId);
  const run = engine.store.getRun(forward.runId);
  if (!run) return { kind: 'done', outcome: 'forward-failed', detail: `was NOT received by ${label}: the run is no longer in the run history.` };
  let said = transcripts.get(run.id);
  if (!said) {
    said = (await engine.store.readEvents(run.id)).flatMap(event => event.type === 'user-message' && typeof event.text === 'string' ? [event.text] : []);
    transcripts.set(run.id, said);
  }
  if (said.some(text => text.includes(marker))) {
    return { kind: 'done', outcome: 'forwarded', detail: `was delivered to ${label}: it is recorded in that run's transcript.` };
  }
  const stacked = (run.queuedMessages ?? []).some(message => message.text.includes(marker));
  if (stacked && run.status !== 'queued' && run.startedAt) {
    return { kind: 'done', outcome: 'forwarded', detail: `was delivered to ${label}: it is part of the prompt that run started with.` };
  }
  if (!ACTIVE_RUN_STATUSES.has(run.status)) {
    return { kind: 'done', outcome: 'forward-failed', detail: `was NOT received by ${label}: the run ended (${run.status}) before the change reached it. The backlog holds the updated item for the next attempt.` };
  }
  if (stacked) return { kind: 'keep', status: 'queued', detail: 'in the queued prompt; received when the run starts' };
  // A graph gate takes the next user message as its answer: never let a forwarded change answer it.
  if (run.askParked) {
    return { kind: 'keep', status: 'pending', detail: 'held: the run is waiting for the user\'s answer to its own question', notice: `is held for ${label}: that run is waiting for your answer to its own question, and the change must not be taken as that answer. It is sent once the run continues. NOT received yet.` };
  }
  if (run.status !== 'queued') {
    const blocked = await engine.runBlocked(run).catch(error => String(error));
    if (blocked) return { kind: 'keep', status: 'pending', detail: `held: ${blocked}`.slice(0, 2000), notice: `is held for ${label}: ${blocked}. It is sent once the provider is available. NOT received yet.` };
  }
  const content = [{ type: 'text' as const, text: forward.text }];
  if (engine.manager.sendMessage(run.id, content)) {
    return { kind: 'done', outcome: 'forwarded', detail: `was delivered into the live session of ${label} and recorded in its transcript.` };
  }
  if (run.status === 'queued') {
    const refusal = queuedStackRefusal(engine.dataDir, run, content, forward.text);
    if (refusal) {
      return { kind: 'keep', status: 'pending', detail: `held: the queued prompt cannot take it (${refusal})`.slice(0, 2000), notice: `is held for ${label}: its queued prompt cannot take it (${refusal}). It is sent into the session once the run starts. NOT received yet.` };
    }
    if (engine.manager.enqueueMessage(run.id, content)) {
      return { kind: 'keep', status: 'queued', detail: 'in the queued prompt; received when the run starts', notice: `was added to the queued prompt of ${label}; the agent receives it when the run starts. NOT received yet.` };
    }
  }
  return { kind: 'keep', status: 'pending', detail: 'held: the run has no open session right now', notice: `is held for ${label}: the run has no open session right now (starting, between steps or parked). It is sent when a session opens; if the run ends first, it is reported as not received. NOT received yet.` };
}
