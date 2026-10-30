import type { ScrumChatLogEntry, ScrumProvenance, ScrumState } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { appendLog, entry } from './chat.ts';
import { stateProblems } from './validate.ts';

/**
 * SCRUM-CHAT-01 follow-up policies approved on 2026-10-30 (docs/skorowidny-cezar/scrum-chat.md,
 * Q2 and Q4). Pure state transitions run under the Scrum lock by the reconcile; delivery of chat
 * changes to running agents (Q1) lives with the engine calls in `server/scrum.ts`.
 *
 * @author Skorowid
 */

/** Sprints in these states hold an explicit plan the user made; the policy never moves such an item. */
const PLANNING_STATUSES = new Set(['planned', 'active']);

/**
 * Q4: a chat item that became READY with no Sprint named goes into the single active Sprint.
 * With no active Sprint nothing is created; a `question` asks the user in the conversation.
 */
export function planReadyItems(
  state: ScrumState, becameReady: ReadonlyMap<string, ScrumProvenance>, plannedExplicitly: ReadonlySet<string>,
  origin: { runId: string; turnSeq: number },
): ScrumState {
  const log: ScrumChatLogEntry[] = [];
  let current = state;
  for (const [itemId, provenance] of becameReady) {
    const item = current.items.find(entry => entry.id === itemId);
    if (!item?.autoQueue || item.deliveryStatus === 'done' || plannedExplicitly.has(itemId)) continue;
    if (current.sprints.some(sprint => PLANNING_STATUSES.has(sprint.status) && sprint.itemIds.includes(itemId))) continue;
    const active = current.sprints.filter(sprint => sprint.status === 'active');
    if (active.length !== 1) {
      log.push(entry(origin, 'autoPlan', 'question', `"${item.title}" is READY but no Sprint was named and no Sprint is active. Which Sprint should it go into? cezar does not create Sprints; until it is planned in the active Sprint it is not queued.`, provenance.quote, itemId));
      continue;
    }
    const sprint = active[0]!;
    const next: ScrumState = {
      ...current,
      sprints: current.sprints.map(entry => entry.id === sprint.id
        ? { ...entry, itemIds: [...entry.itemIds, itemId], provenance: [...(entry.provenance ?? []), provenance].slice(-200) }
        : entry),
    };
    const before = new Set(stateProblems(current));
    const introduced = stateProblems(next).filter(problem => !before.has(problem));
    if (introduced.length) {
      log.push(entry(origin, 'autoPlan', 'refused', `"${item.title}" could not be planned into "${sprint.name}": ${introduced.join('; ')}`, provenance.quote, itemId, sprint.id));
      continue;
    }
    current = next;
    log.push(entry(origin, 'autoPlan', 'applied', `"${item.title}" planned into the active Sprint "${sprint.name}" (no Sprint was named)`, provenance.quote, itemId, sprint.id));
  }
  return appendLog(current, log);
}

/**
 * Q2: an automatic attempt that failed is reported once in the conversation and never retried
 * by itself; the user answers in the chat and only an explicit `retryItem` queues another one.
 */
export function reportFailedRuns(state: ScrumState, store: RunStore): ScrumState {
  const log: ScrumChatLogEntry[] = [];
  const items = state.items.map(item => {
    if (!item.autoRunId || item.autoFailureReported === item.autoRunId || item.autoRetry) return item;
    const run = store.getRun(item.autoRunId);
    if (run?.status !== 'failed') return item;
    const reason = run.error?.trim() ? `: ${run.error.trim().slice(0, 300)}` : '';
    log.push(entry({ runId: null, turnSeq: 0 }, 'autoRun', 'run-failed', `The automatic attempt for "${item.title}" (run ${run.id.slice(0, 8)}) failed${reason}. It is not retried automatically — do you want another attempt? Say so in the chat.`, '', item.id));
    return { ...item, autoFailureReported: item.autoRunId };
  });
  return log.length ? appendLog({ ...state, items }, log) : state;
}

/** When the item's latest attempt ended, or started if it is still open; undefined before any attempt. */
export function lastAttemptAt(state: ScrumState, store: RunStore, itemId: string): string | undefined {
  const runId = state.items.find(item => item.id === itemId)?.runIds.at(-1);
  const run = runId ? store.getRun(runId) : undefined;
  return run ? run.finishedAt ?? run.createdAt : undefined;
}
