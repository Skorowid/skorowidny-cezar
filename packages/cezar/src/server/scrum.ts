import { Hono, type MiddlewareHandler } from 'hono';
import {
  SCRUM_RUN_HISTORY_LIMIT, scrumItemParamsSchema, scrumLaunchInputSchema, scrumSaveInputSchema, scrumLaunchResponseSchema,
  type RunStatus,
} from '@open-mercato/cezar-contract';
import type { ProjectContext } from './project-context.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';
import { buildScrumPrompt } from '../scrum/prompt.ts';
import { readScrumState, updateScrumState } from '../scrum/store.ts';
import { implementationBlockers, runHistoryProblems, ScrumError, stateProblems } from '../scrum/validate.ts';

/**
 * SCRUM-LOCAL-01 route family: `GET/PUT /scrum` and `POST /scrum/items/:id/launch`, mounted by
 * `server.ts` under the project scope. Execution stays in the existing engine: `launch` is the
 * caller's provider gate + `RunManager.startRun`.
 *
 * @author Skorowid
 */

export type ScrumLauncher = (project: ProjectContext, prompt: string, readOnly: boolean) => Promise<{ id: string }>;
type ScrumEnv = { Variables: { project: ProjectContext } };

/** A run in one of these still holds the item: a second attempt would race it. */
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting']);

const noStore: MiddlewareHandler<ScrumEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

export function createScrumRoutes(launch: ScrumLauncher) {
  return new Hono<ScrumEnv>()
    .onError((error, c) => {
      if (error instanceof ScrumError) return c.json({ error: error.message }, error.status);
      return c.json({ error: 'Scrum is temporarily unavailable. Try again, or restart cezar if it keeps happening.' }, 503);
    })
    .use('/scrum', noStore).use('/scrum/*', noStore)
    .get('/scrum', async c => c.json(await readScrumState(c.get('project').dataDir)))
    .put('/scrum', jsonZodValidator(scrumSaveInputSchema), async c => {
      const { expectedRevision, state } = c.req.valid('json');
      const saved = await updateScrumState(c.get('project').dataDir, expectedRevision, async current => {
        const problems = [...runHistoryProblems(current, state), ...stateProblems(state)];
        if (problems.length) throw new ScrumError(400, problems.join('; '));
        return { state, result: undefined };
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
          started = await launch(project, buildScrumPrompt(current, item, mode), mode === 'refine');
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
    });
}
