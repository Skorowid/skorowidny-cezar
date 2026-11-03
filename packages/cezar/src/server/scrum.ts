import { Hono, type MiddlewareHandler } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SCRUM_APPROVABLE_DOCUMENT_KINDS, SCRUM_CHAT_NOTICE_OUTCOMES, SCRUM_KICKOFF_QUESTIONS, SCRUM_RUN_HISTORY_LIMIT, scrumArtifactParamsSchema, scrumChatMessageInputSchema, scrumCoordinatorSaveSchema,
  scrumDocumentContentSchema, scrumDocumentDecisionSchema, scrumDocumentParamsSchema, scrumDocumentQuerySchema, scrumItemParamsSchema, scrumLaunchInputSchema, scrumSaveInputSchema, scrumLaunchResponseSchema,
  type ScrumChatDelivery, type ScrumChatMessage, type ScrumChatView, type ScrumCoordinatorModelSource, type ScrumCoordinatorView, type ScrumState,
} from '@open-mercato/cezar-contract';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { AGENT_MODELS_LOCKED_ERROR, agentModelsLocked } from '../core/agent-model-policy.ts';
import { modelConflictsWithRunner } from '../core/model-presets.ts';
import { artifactsDir, probePreview, validatePreviewUrl } from '../scrum/artifacts.ts';
import { ACTIVE_RUN_STATUSES, autoQueue, busyItemIds, type ScrumLaunchOptions } from '../scrum/autoqueue.ts';
import { SCRUM_COORDINATOR_RUNNER, SCRUM_INTERNAL_PREFIX, appendLog, applyChatOps, chatMessages, emptyChatState, entry, parseTurnOps, turnsAfter, userTexts } from '../scrum/chat.ts';
import { buildContextPacket, storeContextPacket } from '../scrum/context.ts';
import { addWork, coordinatorConfig, kickoffBlockers, latestVersion, newWork, settleKickoff, startKickoff } from '../scrum/coordinator-state.ts';
import { readDocumentVersion, writeDerivedViews } from '../scrum/documents.ts';
import { deliverForwards, planForwards } from '../scrum/forward.ts';
import { lastAttemptAt, planReadyItems, reportFailedRuns } from '../scrum/policy.ts';
import { buildScrumPrompt } from '../scrum/prompt.ts';
import { readScrumState, updateScrumState } from '../scrum/store.ts';
import { implementationBlockers, keepServerOwned, runHistoryProblems, ScrumError, stateProblems } from '../scrum/validate.ts';
import { deliverInbox, refinementPrompt, startPendingWork, syncWork } from '../scrum/work.ts';

/**
 * Scrum route family (SCRUM-LOCAL-01, SCRUM-CHAT-01): `GET/PUT /scrum`,
 * `POST /scrum/items/:id/launch`, `GET /scrum/chat` and `POST /scrum/chat/messages`, mounted by
 * `server.ts` under the project scope. Execution and the chat thread stay in the existing engine:
 * the services are the caller's provider gate + `RunManager`. A chat message travels the same
 * live → queued → start-up → Continue ladder as a message typed into any task; a chat change
 * forwarded to an item's active run goes through the durable outbox in `scrum/forward.ts`.
 *
 * @author Skorowid
 */

export interface ScrumServices {
  /** Start an implementation, review or read-only consultation run on the given agent choice. */
  launch(project: ProjectContext, prompt: string, options: ScrumLaunchOptions): Promise<{ id: string }>;
  /** Start a new coordinator thread: a read-only OpenCode run whose task is the author's message. */
  startChat(project: ProjectContext, text: string, model: string | undefined): Promise<{ id: string }>;
  /** Which model the coordinator runs on, from the project's configured OpenCode choice. Never a hardcoded name. */
  coordinatorModel(project: ProjectContext, override: string | null): Promise<{ model: string | null; source: ScrumCoordinatorModelSource; locked: boolean }>;
  /** Why the coordinator cannot run on this machine right now; null when nothing is known against it. */
  coordinatorBlocker(project: ProjectContext): Promise<string | null>;
  /** Why an existing run's provider (the chat thread's or an item run's) cannot take a message now; empty when it can. */
  runBlocked(project: ProjectContext, run: RunRecord): Promise<string | null | undefined>;
}

type ScrumEnv = { Variables: { project: ProjectContext } };

const noStore: MiddlewareHandler<ScrumEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

const MAX_VIEW_MESSAGES = 400;
const RECONCILE_DELAY_MS = 250;
/** Delivery passes for held changes: at most one per second per project, never postponed by a busy run. */
const FORWARD_DELAY_MS = 1000;

/** Thread and automatic run ids per data dir, so the listeners can ignore every other run cheaply. */
const knownThreads = new Map<string, Set<string>>();
const knownAutoRuns = new Map<string, Set<string>>();
const knownForwardRuns = new Map<string, Set<string>>();
const knownWorkRuns = new Map<string, Set<string>>();
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const forwardTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSweeps = new Set<string>();
const attached = new WeakSet<ProjectContext['store']>();

function remember(dataDir: string, state: ScrumState): void {
  const threads = state.chat?.threads.map(thread => thread.runId) ?? [];
  knownThreads.set(dataDir, new Set(threads));
  knownAutoRuns.set(dataDir, new Set(state.items.flatMap(item => item.autoRunId ? [item.autoRunId] : [])));
  knownForwardRuns.set(dataDir, new Set((state.chat?.forwards ?? []).map(forward => forward.runId)));
  knownWorkRuns.set(dataDir, new Set((state.work ?? []).flatMap(work => work.runId && ['active', 'waiting', 'pending'].includes(work.status) ? [work.runId] : [])));
}

const launcherFor = (services: ScrumServices, project: ProjectContext) =>
  (prompt: string, options: ScrumLaunchOptions) => services.launch(project, prompt, options);

/**
 * Absorb every finished chat turn the backlog has not seen yet, then queue what became
 * executable. The cursor moves in the same atomic save as the operations it applied.
 */
export async function reconcileScrumChat(project: ProjectContext, services: ScrumServices, sweep = false): Promise<ScrumState> {
  const { state: absorbed } = await updateScrumState(project.dataDir, null, async current => {
    remember(project.dataDir, current);
    let next = current;
    let changed = false;
    let origin: { runId: string; turnSeq: number } | null = null;
    const chat = current.chat;
    const thread = chat?.threadRunId ? project.store.getRun(chat.threadRunId) : undefined;
    if (chat && thread) {
      const from = chat.cursor?.runId === thread.id ? chat.cursor.seq : 0;
      const events = project.store.readEvents(thread.id);
      const said = [
        ...userTexts(thread.task, thread.createdAt, events),
        // cezar's own hand-over of agent results is never the author's words.
        ...(thread.queuedMessages ?? []).filter(message => !message.text.startsWith(SCRUM_INTERNAL_PREFIX)).map(message => ({ text: message.text, at: message.createdAt })),
      ];
      for (const turn of turnsAfter(events, from)) {
        const { ops, problems } = parseTurnOps(turn);
        const before = next;
        const applied = applyChatOps(next, ops, problems, {
          runId: thread.id, turnSeq: turn.seq, at: turn.at, dataDir: project.dataDir, userTexts: said, busyItemIds: busyItemIds(next, project.store),
          lastAttemptAt: itemId => lastAttemptAt(before, project.store, itemId),
        });
        origin = { runId: thread.id, turnSeq: turn.seq };
        next = planReadyItems(applied.state, applied.becameReady, applied.plannedExplicitly, origin);
        // Q1: recorded in this save, delivered by the pass below — never handed over before it is durable.
        for (const [itemId, quotes] of applied.changedBusy) next = planForwards(next, project.store, itemId, quotes, origin);
        next = { ...next, chat: { ...(next.chat ?? emptyChatState()), cursor: { runId: thread.id, seq: turn.seq } } };
        changed = true;
      }
    }
    const reported = reportFailedRuns(next, project.store);
    if (reported !== next) { next = reported; changed = true; }
    // Results read from the runs' transcripts; may record a review to start below.
    const synced = await syncWork(next, project.store, project.dataDir);
    if (synced !== next) { next = synced; changed = true; }
    // Queue only when something could have changed readiness (a new turn, boot catch-up); a
    // failed start is retried then, not on every chat poll.
    if (changed || sweep) {
      const queued = await autoQueue(next, project.store, launcherFor(services, project), origin, project.dataDir);
      if (queued !== next) { next = queued; changed = true; }
      const started = await startPendingWork(next, project.store, launcherFor(services, project), project.dataDir);
      if (started !== next) { next = started; changed = true; }
    }
    if (changed) remember(project.dataDir, next);
    return { state: next, result: undefined, unchanged: !changed };
  });
  // A busy lock only delays delivery: the outbox is already saved and the next pass picks it up.
  const forwarded = absorbed.chat?.forwards?.length ? await deliverScrumForwards(project, services).catch(() => absorbed) : absorbed;
  return forwarded.chat?.inbox?.length ? deliverScrumInbox(project, services).catch(() => forwarded) : forwarded;
}

/** SCRUM-COORD-01: one delivery pass of agent results into the coordinator's thread (`scrum/work.ts`). */
export async function deliverScrumInbox(project: ProjectContext, services: ScrumServices): Promise<ScrumState> {
  const { state } = await updateScrumState(project.dataDir, null, async current => {
    const delivered = await deliverInbox(current, {
      dataDir: project.dataDir, store: project.store, manager: project.manager, runBlocked: run => services.runBlocked(project, run),
    });
    return { state: delivered.state, result: undefined, unchanged: delivered.unchanged };
  });
  return state;
}

/** Q1: one delivery pass over the changes still on their way to active runs (`scrum/forward.ts`). */
export async function deliverScrumForwards(project: ProjectContext, services: ScrumServices): Promise<ScrumState> {
  const { state } = await updateScrumState(project.dataDir, null, async current => {
    const delivered = await deliverForwards(current, {
      dataDir: project.dataDir, store: project.store, manager: project.manager, runBlocked: run => services.runBlocked(project, run),
    });
    if (!delivered.unchanged) remember(project.dataDir, delivered.state);
    return { state: delivered.state, result: undefined, unchanged: delivered.unchanged };
  });
  return state;
}

/** A held change is retried when its run moves; one pending timer, so a streaming run cannot starve it. */
function scheduleForwards(project: ProjectContext, services: ScrumServices): void {
  if (forwardTimers.has(project.dataDir)) return;
  forwardTimers.set(project.dataDir, setTimeout(() => {
    forwardTimers.delete(project.dataDir);
    void deliverScrumForwards(project, services).catch(() => undefined);
  }, FORWARD_DELAY_MS));
}

function scheduleReconcile(project: ProjectContext, services: ScrumServices, sweep = false): void {
  clearTimeout(reconcileTimers.get(project.dataDir));
  // A sweep asked for earlier must survive a plain reconcile that replaces its timer.
  if (sweep) pendingSweeps.add(project.dataDir);
  reconcileTimers.set(project.dataDir, setTimeout(() => {
    reconcileTimers.delete(project.dataDir);
    const swept = pendingSweeps.delete(project.dataDir);
    // Best effort: a busy or corrupt state is retried on the next turn or the next chat read.
    void reconcileScrumChat(project, services, swept).catch(() => undefined);
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
    if (event.type === 'turn-end' && knownWorkRuns.get(project.dataDir)?.has(runId)) scheduleReconcile(project, services);
    if (knownForwardRuns.get(project.dataDir)?.has(runId)) scheduleForwards(project, services);
  };
  // Q2: a failed automatic attempt is reported in the conversation even when no Scrum page is open.
  const runListener = (run: RunRecord) => {
    if (run.status === 'failed' && knownAutoRuns.get(project.dataDir)?.has(run.id)) scheduleReconcile(project, services);
    // SCRUM-COORD-01: a settled or parked agent returns its result even when no Scrum page is open.
    if (run.status !== 'queued' && run.status !== 'running' && knownWorkRuns.get(project.dataDir)?.has(run.id)) scheduleReconcile(project, services);
    // The coordinator's turn ended or it settled: results held for it can go in now.
    if (run.status !== 'running' && knownThreads.get(project.dataDir)?.has(run.id)) scheduleReconcile(project, services);
    if (knownForwardRuns.get(project.dataDir)?.has(run.id)) scheduleForwards(project, services);
  };
  project.store.on('event', listener);
  project.store.on('run', runListener);
  scheduleReconcile(project, services, true);
  return () => {
    project.store.off('event', listener);
    project.store.off('run', runListener);
    pendingSweeps.delete(project.dataDir);
    attached.delete(project.store);
    clearTimeout(reconcileTimers.get(project.dataDir));
    reconcileTimers.delete(project.dataDir);
    clearTimeout(forwardTimers.get(project.dataDir));
    forwardTimers.delete(project.dataDir);
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
  // cezar's own notices (delivery to running agents, failed attempts, questions) join the conversation in time order.
  for (const logged of chat.log) {
    if (SCRUM_CHAT_NOTICE_OUTCOMES.includes(logged.outcome)) messages.push({ seq: 0, role: 'system', text: logged.outcome === 'refused' ? `Refused ${logged.op}: ${logged.detail}` : logged.detail, at: logged.at });
  }
  messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const thread = chat.threadRunId ? project.store.getRun(chat.threadRunId) : undefined;
  return {
    threadRunId: thread ? thread.id : null,
    threadStatus: thread ? thread.status : null,
    threadRunner: thread?.runner ?? null,
    messages: messages.slice(-MAX_VIEW_MESSAGES),
    truncated: messages.length > MAX_VIEW_MESSAGES,
    state,
  };
}

type Delivered = { delivery: 'delivered' | 'queued' | 'deferred' | 'resumed' } | { error: string; busy: boolean };

/** The engine's message ladder for one existing run: live session, queued prompt, start-up buffer, Continue. */
function deliverText(project: ProjectContext, run: RunRecord, text: string, model: string | undefined): Delivered {
  const content = [{ type: 'text' as const, text }];
  const { manager } = project;
  if (manager.sendMessage(run.id, content)) return { delivery: 'delivered' };
  if (manager.enqueueMessage(run.id, content)) return { delivery: 'queued' };
  if (manager.deferMessage(run.id, content)) return { delivery: 'deferred' };
  // A changed OpenCode choice takes effect when the session reopens; a live session keeps its model.
  const resumed = manager.continueRun(run.id, { text, ...(model && model !== run.model ? { model } : {}) });
  if (resumed.ok) return { delivery: 'resumed' };
  const busy = resumed.error === 'run is still active';
  return { busy, error: busy ? 'its session cannot take a message right now (it is parked or between turns)' : resumed.error ?? 'the run cannot take messages' };
}

/** Deliver into the existing thread; undefined means it cannot take messages any more. */
function deliver(project: ProjectContext, thread: RunRecord, text: string, model: string | undefined): ScrumChatDelivery | undefined {
  const sent = deliverText(project, thread, text, model);
  if ('delivery' in sent) return sent.delivery;
  if (sent.busy) {
    throw new ScrumError(409, 'The coordinator is still answering; send your message when its reply has finished');
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
        const queued = await autoQueue(next, project.store, launcherFor(services, project), null, project.dataDir);
        remember(project.dataDir, queued);
        return { state: queued, result: undefined };
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
        const config = coordinatorConfig(current);
        const packet = buildContextPacket(project.dataDir, current, item);
        // Refinement is one consultation like any other, so its result returns to the coordinator too.
        const refinement = mode === 'refine' ? newWork('consult', { itemId: id, request: `BA refinement of "${item.title}"`.slice(0, 4000), status: 'active' }) : undefined;
        const prompt = refinement ? refinementPrompt(current, item, refinement, packet) : buildScrumPrompt(current, item, mode, packet);
        let started: { id: string };
        try {
          started = await services.launch(project, prompt, { readOnly: mode === 'refine', agent: mode === 'refine' ? config.agents.consult : config.agents.implement });
        } catch (error) {
          throw new ScrumError(409, `The agent run could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        const runId = scrumLaunchResponseSchema.shape.runId.safeParse(started.id);
        if (!runId.success) throw new ScrumError(503, 'The run engine returned an invalid run id');
        const run = project.store.getRun(runId.data);
        const agent = { runId: runId.data, runner: run?.runner ?? null, model: run?.model ?? null };
        const work = refinement ? { ...refinement, ...agent } : newWork('implement', { itemId: id, request: `Implement "${item.title}"`.slice(0, 4000), status: 'active', ...agent });
        const linked = { ...current, items: current.items.map(entry => entry.id === id ? { ...entry, runIds: [...entry.runIds, runId.data] } : entry) };
        const saved = addWork(mode === 'refine' ? linked : storeContextPacket(project.dataDir, linked, item, packet, runId.data), work);
        remember(project.dataDir, saved);
        return { state: saved, result: runId.data };
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
      const { state, result } = await updateScrumState(project.dataDir, null, async stored => {
        const chat = stored.chat ?? emptyChatState();
        if (chat.messageIds.includes(clientMessageId) && chat.threadRunId) {
          return { state: stored, result: { delivery: 'duplicate' as const, threadRunId: chat.threadRunId }, unchanged: true };
        }
        const unavailable = await services.coordinatorBlocker(project);
        if (unavailable) throw new ScrumError(409, unavailable);
        const current = startKickoff(stored);
        const resolved = await services.coordinatorModel(project, coordinatorConfig(current).model);
        const model = resolved.locked ? undefined : resolved.model ?? undefined;
        const known = chat.threadRunId ? project.store.getRun(chat.threadRunId) : undefined;
        // SCRUM-COORD-01: an older thread on another runner stays readable; the coordinator is always OpenCode.
        const thread = known?.runner === SCRUM_COORDINATOR_RUNNER ? known : undefined;
        if (known && !thread && ACTIVE_RUN_STATUSES.has(known.status) && known.status !== 'waiting') {
          throw new ScrumError(409, 'The previous assistant is still answering; send your message when its reply has finished');
        }
        let delivery: ScrumChatDelivery | undefined;
        if (thread) {
          if (thread.status !== 'queued') {
            const blocked = await services.runBlocked(project, thread);
            if (blocked) throw new ScrumError(409, blocked);
          }
          delivery = deliver(project, thread, text, model);
        }
        let next = chat;
        if (thread && delivery) {
          next = { ...chat, messageIds: [...chat.messageIds, clientMessageId].slice(-100) };
        } else {
          let started: { id: string };
          try {
            writeDerivedViews(project.dataDir, current);
            started = await services.startChat(project, text, model);
          } catch (error) {
            throw new ScrumError(409, `The coordinator could not start on OpenCode: ${error instanceof Error ? error.message : String(error)}`);
          }
          const runId = scrumLaunchResponseSchema.shape.runId.safeParse(started.id);
          if (!runId.success) throw new ScrumError(503, 'The run engine returned an invalid run id');
          const reason = thread
            ? `the previous thread ${thread.id.slice(0, 8)} could not be resumed`
            : known ? `the coordinator moved to OpenCode; the previous ${known.runner ?? 'agent'} thread ${known.id.slice(0, 8)} stays readable`
            : chat.threadRunId ? 'the previous thread is no longer in the run history' : 'first message';
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
    })
    .get('/scrum/coordinator', async c => {
      const project = c.get('project');
      return c.json(await coordinatorView(project, services, await readScrumState(project.dataDir)));
    })
    .put('/scrum/coordinator', jsonZodValidator(scrumCoordinatorSaveSchema), async c => {
      const project = c.get('project');
      const { expectedRevision, config } = c.req.valid('json');
      const named = [config.model, ...Object.values(config.agents).map(agent => agent.model)].some(model => model?.trim());
      if (named && agentModelsLocked(project.root)) throw new ScrumError(409, AGENT_MODELS_LOCKED_ERROR);
      if (config.model && modelConflictsWithRunner(config.model, SCRUM_COORDINATOR_RUNNER)) throw new ScrumError(400, `Model "${config.model}" is not an OpenCode model`);
      for (const agent of Object.values(config.agents)) {
        if (agent.runner && agent.model && modelConflictsWithRunner(agent.model, agent.runner)) throw new ScrumError(400, `Model "${agent.model}" is not a ${agent.runner} model`);
      }
      const { state } = await updateScrumState(project.dataDir, expectedRevision, async current => ({ state: { ...current, coordinator: config }, result: undefined }));
      return c.json(await coordinatorView(project, services, state));
    })
    .get('/scrum/documents/:id', paramZodValidator(scrumDocumentParamsSchema), queryZodValidator(scrumDocumentQuerySchema), async c => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const { version } = c.req.valid('query');
      const document = (await readScrumState(project.dataDir)).documents?.find(entry => entry.id === id);
      if (!document) throw new ScrumError(404, 'Document not found');
      const content = readDocumentVersion(project.dataDir, document, version === undefined ? undefined : Number(version));
      if (!content) throw new ScrumError(404, `${document.code} has no such version`);
      return c.json(scrumDocumentContentSchema.parse(content));
    })
    // The accountable human's decision, on one exact version.
    .post('/scrum/documents/:id/decision', paramZodValidator(scrumDocumentParamsSchema), jsonZodValidator(scrumDocumentDecisionSchema), async c => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const { expectedRevision, version, decision } = c.req.valid('json');
      const { state } = await updateScrumState(project.dataDir, expectedRevision, async current => {
        const document = current.documents?.find(entry => entry.id === id);
        if (!document) throw new ScrumError(404, 'Document not found');
        if (!SCRUM_APPROVABLE_DOCUMENT_KINDS.includes(document.kind)) throw new ScrumError(409, `${document.code} is not a requirement or decision to approve`);
        const latest = latestVersion(document).version;
        if (decision === 'approve' && version !== latest) throw new ScrumError(409, `${document.code} is at v${latest}; reload and read it before approving`);
        if (decision === 'revoke' && document.approval?.version !== version) throw new ScrumError(409, `${document.code} v${version} is not the approved version`);
        const approval = decision === 'approve' ? { version, by: 'cockpit' as const, at: new Date().toISOString(), provenance: null } : null;
        const next = settleKickoff({ ...current, documents: current.documents?.map(entry => entry.id === id ? { ...entry, approval } : entry) ?? [] });
        const queued = await autoQueue(next, project.store, launcherFor(services, project), null, project.dataDir);
        remember(project.dataDir, queued);
        return { state: appendLog(queued, [entry({ runId: null, turnSeq: 0 }, 'documentDecision', 'applied', `${document.code} v${version} ${decision === 'approve' ? 'approved' : 'approval withdrawn'} in the cockpit`, '')]), result: undefined };
      });
      return c.json(state);
    })
    // A probe only: one bounded request to a validated loopback address. Nothing is ever started from it.
    .post('/scrum/artifacts/:id/check', paramZodValidator(scrumArtifactParamsSchema), async c => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const artifact = (await readScrumState(project.dataDir)).work?.flatMap(work => work.artifacts).find(entry => entry.id === id);
      if (!artifact) throw new ScrumError(404, 'Artifact not found');
      if (artifact.kind !== 'preview' || !artifact.url) throw new ScrumError(409, 'Only a valid preview link can be checked');
      const valid = validatePreviewUrl(artifact.url, c.req.header('host'));
      const probed = 'url' in valid ? await probePreview(valid.url) : { status: 'unreachable' as const, reason: valid.problem };
      const { state } = await updateScrumState(project.dataDir, null, async current => ({
        state: {
          ...current,
          work: current.work?.map(work => ({
            ...work,
            artifacts: work.artifacts.map(entry => entry.id === id ? { ...entry, status: probed.status, reason: probed.reason, checkedAt: new Date().toISOString() } : entry),
          })) ?? [],
        },
        result: undefined,
      }));
      return c.json(state);
    })
    // A verified copy only. Images render inline; anything else is a download, never a page on this origin.
    .get('/scrum/artifacts/:id/content', paramZodValidator(scrumArtifactParamsSchema), async c => {
      const project = c.get('project');
      const { id } = c.req.valid('param');
      const work = (await readScrumState(project.dataDir)).work?.find(entry => entry.artifacts.some(artifact => artifact.id === id));
      const artifact = work?.artifacts.find(entry => entry.id === id);
      if (!work || !artifact) throw new ScrumError(404, 'Artifact not found');
      if (artifact.status !== 'verified' || !artifact.storedAs || !/^[a-f0-9]{64}(\.[a-z0-9]+)?$/.test(artifact.storedAs)) throw new ScrumError(409, 'This artifact was not verified, so there is nothing to serve');
      let bytes: Buffer;
      try {
        bytes = await readFile(join(artifactsDir(project.dataDir, work.id), artifact.storedAs));
      } catch {
        throw new ScrumError(404, 'The stored copy of this artifact is gone');
      }
      const image = artifact.kind === 'screenshot' && artifact.mediaType?.startsWith('image/');
      return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
        'content-type': image ? artifact.mediaType! : 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        ...(image ? {} : { 'content-disposition': `attachment; filename="${artifact.storedAs}"` }),
      });
    });
}

async function coordinatorView(project: ProjectContext, services: ScrumServices, state: ScrumState): Promise<ScrumCoordinatorView> {
  const config = coordinatorConfig(state);
  const resolved = await services.coordinatorModel(project, config.model);
  const answers = new Map((state.kickoff?.answers ?? []).map(answer => [answer.questionId, answer]));
  const started = state.kickoff !== undefined;
  // Before the coordinator started, an empty project is under the gate as soon as it does.
  const preview = started ? state : startKickoff(state);
  return {
    revision: state.revision,
    config,
    runner: SCRUM_COORDINATOR_RUNNER,
    resolvedModel: resolved.model,
    modelSource: resolved.source,
    modelsLocked: resolved.locked,
    blocker: (await services.coordinatorBlocker(project))?.slice(0, 1000) ?? null,
    kickoff: {
      required: preview.kickoff?.required ?? false,
      complete: preview.kickoff?.completedAt != null,
      blockers: kickoffBlockers(preview).map(blocker => blocker.slice(0, 500)).slice(0, 100),
      questions: SCRUM_KICKOFF_QUESTIONS.map(question => ({
        id: question.id, topic: question.topic, question: question.question, essential: question.essential,
        status: answers.get(question.id)?.status ?? 'open', answer: answers.get(question.id)?.answer ?? '',
      })),
    },
  };
}
