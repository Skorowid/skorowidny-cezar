import type { RunStatus, ScrumChatLogEntry, ScrumState } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { appendLog, entry } from './chat.ts';
import { buildScrumPrompt, scrumItemMarker } from './prompt.ts';
import { implementationBlockers } from './validate.ts';

/**
 * SCRUM-CHAT-01 automatic queue: a chat-made item that has become executable gets exactly one
 * implementation run, started through the same launcher as the Implement button (provider gate +
 * `RunManager.startRun`), so it waits for a free `maxParallel` slot like any other task. Runs
 * under the Scrum state lock; `autoRunId` is written in the same save, which is what keeps a
 * retry, a restart or a concurrent turn from starting a second run.
 *
 * @author Skorowid
 */

/** A run in one of these still holds the item: a second attempt would race it. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting']);

export type ScrumLauncher = (prompt: string, readOnly: boolean) => Promise<{ id: string }>;

export function busyItemIds(state: ScrumState, store: RunStore): Set<string> {
  return new Set(state.items.filter(item => item.runIds.some(runId => {
    const status = store.getRun(runId)?.status;
    return status !== undefined && ACTIVE_RUN_STATUSES.has(status);
  })).map(item => item.id));
}

export async function autoQueue(
  state: ScrumState, store: RunStore, launch: ScrumLauncher, origin: { runId: string; turnSeq: number } | null,
): Promise<ScrumState> {
  const busy = busyItemIds(state, store);
  const log: ScrumChatLogEntry[] = [];
  let current = state;
  const ordered = [...state.items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const candidate of ordered) {
    const item = current.items.find(entry => entry.id === candidate.id);
    if (!item?.autoQueue || item.autoRunId || item.deliveryStatus !== 'open' || busy.has(item.id)) continue;
    if (implementationBlockers(current, item).length) continue;
    const at = origin ?? { runId: null, turnSeq: 0 };
    const marker = scrumItemMarker(item.id);
    // Someone already started an implementation attempt by hand: the automatic one is spent.
    if (item.runIds.some(runId => store.getRun(runId)?.task.includes(marker))) continue;
    // A run started before a crash could not record itself: adopt it instead of starting another.
    const orphan = store.listRuns().find(run => !item.runIds.includes(run.id) && run.task.includes(marker));
    let runId: string;
    if (orphan) {
      runId = orphan.id;
    } else {
      try {
        runId = (await launch(buildScrumPrompt(current, item, 'implement'), false)).id;
      } catch (error) {
        log.push(entry(at, 'autoQueue', 'queue-failed', `"${item.title}" could not be queued: ${error instanceof Error ? error.message : String(error)}`, '', item.id));
        continue;
      }
    }
    current = { ...current, items: current.items.map(entry => entry.id === item.id ? { ...entry, autoRunId: runId, runIds: [...entry.runIds, runId] } : entry) };
    log.push(entry(at, 'autoQueue', 'queued', `"${item.title}" queued for an execution agent as run ${runId.slice(0, 8)}${orphan ? ' (recovered after a restart)' : ''}`, '', item.id));
  }
  return appendLog(current, log);
}
