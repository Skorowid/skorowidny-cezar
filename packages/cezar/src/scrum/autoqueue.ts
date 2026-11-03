import type { RunStatus, ScrumAgentChoice, ScrumChatLogEntry, ScrumState } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { appendLog, entry } from './chat.ts';
import { buildContextPacket, storeContextPacket } from './context.ts';
import { addWork, coordinatorConfig, newWork } from './coordinator-state.ts';
import { buildScrumPrompt, scrumItemMarker } from './prompt.ts';
import { implementationBlockers } from './validate.ts';

/**
 * SCRUM-CHAT-01 automatic queue: a chat-made item that has become executable gets one
 * implementation run, started through the same launcher as the Implement button (provider gate +
 * `RunManager.startRun`), so it waits for a free `maxParallel` slot like any other task. A further
 * attempt starts only for an explicit chat retry instruction (`autoRetry`, Q2), which the start
 * consumes. Runs under the Scrum state lock; `autoRunId` is written in the same save, which is
 * what keeps a retried request, a restart or a concurrent turn from starting a second run.
 *
 * @author Skorowid
 */

/** A run in one of these still holds the item: a second attempt would race it. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting']);

/** How one assignment runs: read-only consultation, or a worktree task on the configured runner and model. */
export interface ScrumLaunchOptions { readOnly: boolean; agent: ScrumAgentChoice }
export type ScrumLauncher = (prompt: string, options: ScrumLaunchOptions) => Promise<{ id: string }>;

export function busyItemIds(state: ScrumState, store: RunStore): Set<string> {
  return new Set(state.items.filter(item => item.runIds.some(runId => {
    const status = store.getRun(runId)?.status;
    return status !== undefined && ACTIVE_RUN_STATUSES.has(status);
  })).map(item => item.id));
}

export async function autoQueue(
  state: ScrumState, store: RunStore, launch: ScrumLauncher, origin: { runId: string; turnSeq: number } | null, dataDir: string,
): Promise<ScrumState> {
  const busy = busyItemIds(state, store);
  const log: ScrumChatLogEntry[] = [];
  let current = state;
  const ordered = [...state.items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const candidate of ordered) {
    const item = current.items.find(entry => entry.id === candidate.id);
    if (!item || item.deliveryStatus !== 'open' || busy.has(item.id)) continue;
    const retry = item.autoRetry !== undefined;
    if (!retry && (!item.autoQueue || item.autoRunId)) continue;
    if (implementationBlockers(current, item).length) continue;
    const at = origin ?? { runId: null, turnSeq: 0 };
    const marker = scrumItemMarker(item.id);
    // Someone already started an implementation attempt by hand: the automatic one is spent.
    if (!retry && item.runIds.some(runId => store.getRun(runId)?.task.includes(marker))) continue;
    // A run started before a crash could not record itself: adopt it instead of starting another.
    const orphan = store.listRuns().find(run => !item.runIds.includes(run.id) && run.task.includes(marker));
    let runId: string;
    if (orphan) {
      runId = orphan.id;
    } else {
      try {
        const packet = buildContextPacket(dataDir, current, item);
        runId = (await launch(buildScrumPrompt(current, item, 'implement', packet), { readOnly: false, agent: coordinatorConfig(current).agents.implement })).id;
        current = storeContextPacket(dataDir, current, item, packet, runId);
      } catch (error) {
        log.push(entry(at, 'autoQueue', 'queue-failed', `"${item.title}" could not be queued: ${error instanceof Error ? error.message : String(error)}`, '', item.id));
        continue;
      }
    }
    current = {
      ...current,
      items: current.items.map(entry => {
        if (entry.id !== item.id) return entry;
        const { autoRetry: _used, ...rest } = entry;
        return { ...rest, autoRunId: runId, runIds: [...entry.runIds, runId] };
      }),
    };
    // The attempt's result returns to the coordinator through this entry (`work.ts`).
    const run = store.getRun(runId);
    current = addWork(current, newWork('implement', {
      itemId: item.id, request: `Implement "${item.title}"`.slice(0, 4000), runId, status: 'active', runner: run?.runner ?? null, model: run?.model ?? null,
    }));
    const why = retry ? ' — another attempt the user asked for in the chat' : '';
    log.push(entry(at, 'autoQueue', 'queued', `"${item.title}" queued for an execution agent as run ${runId.slice(0, 8)}${why}${orphan ? ' (recovered after a restart)' : ''}`, item.autoRetry?.quote ?? '', item.id));
  }
  return appendLog(current, log);
}
