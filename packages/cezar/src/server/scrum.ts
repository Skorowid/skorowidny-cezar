import { Hono, type MiddlewareHandler } from 'hono';
import {
  SCRUM_RUN_HISTORY_LIMIT, scrumChatMessageInputSchema, scrumItemParamsSchema, scrumLaunchInputSchema, scrumSaveInputSchema, scrumLaunchResponseSchema,
  type ScrumChatDelivery, type ScrumChatMessage, type ScrumChatView, type ScrumState,
} from '@open-mercato/cezar-contract';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';
import { ACTIVE_RUN_STATUSES, autoQueue, busyItemIds } from '../scrum/autoqueue.ts';
import { applyChatOps, chatMessages, emptyChatState, parseTurnOps, turnsAfter, userTexts } from '../scrum/chat.ts';
import { buildScrumPrompt } from '../scrum/prompt.ts';
import { readScrumState, updateScrumState } from '../scrum/store.ts';
import { implementationBlockers, keepServerOwned, runHistoryProblems, ScrumError, stateProblems } from '../scrum/validate.ts';

/**
 * Scrum route family (SCRUM-LOCAL-01, SCRUM-CHAT-01): `GET/PUT /scrum`,
 * `POST /scrum/items/:id/launch`, `GET /scrum/chat` and `POST /scrum/chat/messages`, mounted by
 * `server.ts` under the project scope. Execution and the chat thread stay in the existing engine:
 * the services are the caller's provider gate + `RunManager`, and a chat message travels the same
 * live → queued → start-up → Continue ladder as a message typed into any task.
 *
 * @author Skorowid
 */

export interface ScrumServices {
  /** Start an implementation (or read-only refinement) run with this task text. */
  launch(project: ProjectContext, prompt: string, readOnly: boolean): Promise<{ id: string }>;
  /** Start a new Scrum chat thread: a read-only Codex run whose task is the user's message. */
  startChat(project: ProjectContext, text: string): Promise<{ id: string }>;
  /** Why the existing thread's provider cannot take a message now; empty when it can. */
  threadBlocked(project: ProjectContext, run: RunRecord): Promise<string | null | undefined>;
}

type ScrumEnv = { Variables: { project: ProjectContext } };

const noStore: MiddlewareHandler<ScrumEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

const MAX_VIEW_MESSAGES = 400;
const RECONCILE_DELAY_MS = 250;

/** Thread run ids per data dir, so the event listener can ignore every other run cheaply. */
const knownThreads = new Map<string, Set<string>>();
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const attached = new WeakSet<ProjectContext['store']>();

function remember(dataDir: string, state: ScrumState): void {
  const threads = state.chat?.threads.map(thread => thread.runId) ?? [];
  knownThreads.set(dataDir, new Set(threads));
}

const launcherFor = (services: ScrumServices, project: ProjectContext) =>
  (prompt: string, readOnly: boolean) => services.launch(project, prompt, readOnly);

/**
 * Absorb every finished chat turn the backlog has not seen yet, then queue what became
 * executable. The cursor moves in the same atomic save as the operations it applied.
 */
export async function reconcileScrumChat(project: ProjectContext, services: ScrumServices, sweep = false): Promise<ScrumState> {
  const { state } = await updateScrumState(project.dataDir, null, async current => {
    remember(project.dataDir, current);
    let next = current;
    let changed = false;
    let origin: { runId: string; turnSeq: number } | null = null;
    const chat = current.chat;
    const thread = chat?.threadRunId ? project.store.getRun(chat.threadRunId) : undefined;
    if (chat && thread) {
      const from = chat.cursor?.runId === thread.id ? chat.cursor.seq : 0;
      const events = project.store.readEvents(thread.id);
      const said = [...userTexts(thread.task, events), ...(thread.queuedMessages ?? []).map(message => message.text)];
      for (const turn of turnsAfter(events, from)) {
        const { ops, problems } = parseTurnOps(turn);
        next = applyChatOps(next, ops, problems, {
          runId: thread.id, turnSeq: turn.seq, at: turn.at, userTexts: said, busyItemIds: busyItemIds(next, project.store),
        });
        next = { ...next, chat: { ...(next.chat ?? emptyChatState()), cursor: { runId: thread.id, seq: turn.seq } } };
        origin = { runId: thread.id, turnSeq: turn.seq };
        changed = true;
      }
    }
    // Queue only when something could have changed readiness (a new turn, boot catch-up); a
    // failed start is retried then, not on every chat poll.
    if (changed || sweep) {
      const queued = await autoQueue(next, project.store, launcherFor(services, project), origin);
      if (queued !== next) { next = queued; changed = true; }
    }
    return { state: next, result: undefined, unchanged: !changed };
  });
  return state;
}

function scheduleReconcile(project: ProjectContext, services: ScrumServices, sweep = false): void {
  clearTimeout(reconcileTimers.get(project.dataDir));
  reconcileTimers.set(project.dataDir, setTimeout(() => {
    reconcileTimers.delete(project.dataDir);
    // Best effort: a busy or corrupt state is retried on the next turn or the next chat read.
    void reconcileScrumChat(project, services, sweep).catch(() => undefined);
  }, RECONCILE_DELAY_MS));
}

/**
 * Listen for the project's chat turns (and catch up on turns that ended while cezar was down).
 * Idempotent per store; returns the detach function.
 */
export function attachScrumChat(project: ProjectContext, services: ScrumServices): () => void {
  if (attached.has(project.store)) return () => undefined;
  attached.add(project.store);
  const listener = ({ runId, event }: { runId: string; event: RunEvent }) => {
    if (event.type === 'turn-end' && knownThreads.get(project.dataDir)?.has(runId)) scheduleReconcile(project, services);
  };
  project.store.on('event', listener);
  scheduleReconcile(project, services, true);
  return () => {
    project.store.off('event', listener);
    attached.delete(project.store);
    clearTimeout(reconcileTimers.get(project.dataDir));
    reconcileTimers.delete(project.dataDir);
  };
}

function chatView(project: ProjectContext, state: ScrumState): ScrumChatView {
  const chat = state.chat ?? emptyChatState();
  const messages: ScrumChatMessage[] = [];
  for (const { runId } of chat.threads) {
    const run = project.store.getRun(runId);
    if (!run) continue;
    messages.push(...chatMessages(run.task, run.createdAt, project.store.readEvents(runId)));
    if (run.status === 'queued') {
      for (const queued of run.queuedMessages ?? []) messages.push({ seq: 0, role: 'user', text: queued.text, at: queued.createdAt });
    }
  }
  const thread = chat.threadRunId ? project.store.getRun(chat.threadRunId) : undefined;
  return {
    threadRunId: thread ? thread.id : null,
    threadStatus: thread ? thread.status : null,
    messages: messages.slice(-MAX_VIEW_MESSAGES),
    truncated: messages.length > MAX_VIEW_MESSAGES,
    state,
  };
}

/** Deliver into the existing thread; undefined means it cannot take messages any more. */
function deliver(project: ProjectContext, thread: RunRecord, text: string): ScrumChatDelivery | undefined {
  const content = [{ type: 'text' as const, text }];
  const { manager } = project;
  if (manager.sendMessage(thread.id, content)) return 'delivered';
  if (manager.enqueueMessage(thread.id, content)) return 'queued';
  if (manager.deferMessage(thread.id, content)) return 'deferred';
  const resumed = manager.continueRun(thread.id, { text });
  if (resumed.ok) return 'resumed';
  if (resumed.error === 'run is still active') {
    throw new ScrumError(409, 'The Scrum assistant is still answering; send your message when its reply has finished');
  }
  return undefined;
}

export function createScrumRoutes(services: ScrumServices) {
  return new Hono<ScrumEnv>()
    .onError((error, c) => {
      if (error instanceof ScrumError) return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Scrum is temporarily unavailable. Try again, or restart cezar if it keeps happening.' }, 503);
    })
    .use('/scrum', noStore).use('/scrum/*', noStore)
    .use('/scrum', async (c, next) => { attachScrumChat(c.get('project'), services); await next(); })
    .use('/scrum/*', async (c, next) => { attachScrumChat(c.get('project'), services); await next(); })
    .get('/scrum', async c => c.json(await readScrumState(c.get('project').dataDir)))
    .put('/scrum', jsonZodValidator(scrumSaveInputSchema), async c => {
      const project = c.get('project');
      const { expectedRevision, state } = c.req.valid('json');
      const saved = await updateScrumState(project.dataDir, expectedRevision, async current => {
        const next = keepServerOwned(current, state);
        const problems = [...runHistoryProblems(current, next), ...stateProblems(next)];
        if (problems.length) throw new ScrumError(400, problems.join('; '));
        // An activated Sprint or a finished dependency can make a chat-made item executable.
        return { state: await autoQueue(next, project.store, launcherFor(services, project), null), result: undefined };
      });
      return c.json(saved.state);
    })
    .post('/scrum/items/:id/launch', paramZodValidator(scrumItemParamsSchema), jsonZodValidator(scrumLaunchInputSchema), async c => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const { expectedRevision, mode } = c.req.valid('json');
      // The callback runs under the state lock, so a concurrent launch of the same item waits
      // and then fails on the revision it no longer matches — never a second run.
      const { state, result: runId } = await updateScrumState(project.dataDir, expectedRevision, async current => {
        const item = current.items.find(entry => entry.id === id);
        if (!item) throw new ScrumError(404, 'Product Backlog Item not found');
        if (mode === 'implement') {
          const blockers = implementationBlockers(current, item);
          if (blockers.length) throw new ScrumError(409, `Item is not ready for implementation: ${blockers.join('; ')}`);
        }
        const running = item.runIds.find(runId => {
          const status = project.store.getRun(runId)?.status;
          return status !== undefined && ACTIVE_RUN_STATUSES.has(status);
        });
        if (running) throw new ScrumError(409, `Run ${running.slice(0, 8)} for this item is still active`);
        if (item.runIds.length >= SCRUM_RUN_HISTORY_LIMIT) throw new ScrumError(409, 'This item has reached its run history limit');
        let started: { id: string };
        try {
          started = await services.launch(project, buildScrumPrompt(current, item, mode), mode === 'refine');
        } catch (error) {
          throw new ScrumError(409, `The agent run could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        const runId = scrumLaunchResponseSchema.shape.runId.safeParse(started.id);
        if (!runId.success) throw new ScrumError(503, 'The run engine returned an invalid run id');
        return {
          state: { ...current, items: current.items.map(entry => entry.id === id ? { ...entry, runIds: [...entry.runIds, runId.data] } : entry) },
          result: runId.data,
        };
      });
      return c.json({ state, runId });
    })
    .get('/scrum/chat', async c => {
      const project = c.get('project');
      return c.json(chatView(project, await reconcileScrumChat(project, services)));
    })
    .post('/scrum/chat/messages', jsonZodValidator(scrumChatMessageInputSchema), async c => {
      const project = c.get('project');
      const { clientMessageId, text } = c.req.valid('json');
      // Turns of a thread that is about to be replaced must reach the backlog first.
      await reconcileScrumChat(project, services).catch(() => undefined);
      // Under the state lock: two tabs, a retried POST or a restart never open a second thread
      // or deliver one message twice.
      const { state, result } = await updateScrumState(project.dataDir, null, async current => {
        const chat = current.chat ?? emptyChatState();
        if (chat.messageIds.includes(clientMessageId) && chat.threadRunId) {
          return { state: current, result: { delivery: 'duplicate' as const, threadRunId: chat.threadRunId }, unchanged: true };
        }
        const thread = chat.threadRunId ? project.store.getRun(chat.threadRunId) : undefined;
        let delivery: ScrumChatDelivery | undefined;
        if (thread) {
          if (thread.status !== 'queued') {
            const blocked = await services.threadBlocked(project, thread);
            if (blocked) throw new ScrumError(409, blocked);
          }
          delivery = deliver(project, thread, text);
        }
        let next = chat;
        if (thread && delivery) {
          next = { ...chat, messageIds: [...chat.messageIds, clientMessageId].slice(-100) };
        } else {
          let started: { id: string };
          try {
            started = await services.startChat(project, text);
          } catch (error) {
            throw new ScrumError(409, `The Scrum assistant could not start: ${error instanceof Error ? error.message : String(error)}`);
          }
          const runId = scrumLaunchResponseSchema.shape.runId.safeParse(started.id);
          if (!runId.success) throw new ScrumError(503, 'The run engine returned an invalid run id');
          const reason = thread ? `the previous thread ${thread.id.slice(0, 8)} could not be resumed` : chat.threadRunId ? 'the previous thread is no longer in the run history' : 'first message';
          next = {
            ...chat,
            threadRunId: runId.data,
            threads: [...chat.threads, { runId: runId.data, startedAt: new Date().toISOString(), reason }].slice(-200),
            cursor: { runId: runId.data, seq: 0 },
            messageIds: [...chat.messageIds, clientMessageId].slice(-100),
          };
          delivery = 'started';
        }
        const saved = { ...current, chat: next };
        remember(project.dataDir, saved);
        return { state: saved, result: { delivery: delivery ?? 'started', threadRunId: next.threadRunId ?? '' } };
      });
      return c.json({ delivery: result.delivery, threadRunId: result.threadRunId, state });
    });
}
