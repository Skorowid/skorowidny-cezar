import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { scrumStateSchema, type ScrumState } from '@open-mercato/cezar-contract';
import { renameWithRetry } from '../fs-rename.ts';
import { ScrumError, stateProblems } from './validate.ts';

/**
 * Project-local Scrum state, `<dataDir>/scrum/state.json` (SCRUM-LOCAL-01). A missing file is
 * the empty module; an existing file that does not parse or validate is a 503 and is never
 * overwritten. Writes are tmp+rename under an in-process queue plus a `proper-lockfile` lock,
 * so two cockpits or two processes on one project serialize instead of losing an edit.
 *
 * @author Skorowid
 */

const STALE_MS = 15_000;
// Waiters may sit behind a launch whose provider check takes a few seconds.
const RETRIES = { retries: 60, factor: 1.2, minTimeout: 25, maxTimeout: 400 };
const queues = new Map<string, Promise<unknown>>();

export function emptyScrumState(): ScrumState {
  return { schemaVersion: 1, revision: 0, productGoal: '', definitionOfDone: '', items: [], sprints: [], notes: [] };
}

export function scrumDir(dataDir: string): string {
  return join(dataDir, 'scrum');
}

export function scrumStatePath(dataDir: string): string {
  return join(scrumDir(dataDir), 'state.json');
}

export async function readScrumState(dataDir: string): Promise<ScrumState> {
  let raw: string;
  try {
    raw = await readFile(scrumStatePath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyScrumState();
    throw new ScrumError(503, `Scrum state cannot be read: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw corrupt('it is not valid JSON');
  }
  const parsed = scrumStateSchema.safeParse(json);
  if (!parsed.success) throw corrupt(parsed.error.issues[0]?.message ?? 'schema mismatch');
  const problems = stateProblems(parsed.data);
  if (problems.length) throw corrupt(problems[0] ?? 'integrity check failed');
  return parsed.data;
}

function corrupt(reason: string): ScrumError {
  return new ScrumError(503, `Scrum state file is corrupt (${reason}); it was left untouched — fix or move .ai/cezar/scrum/state.json`);
}

/**
 * Run `mutate` against the freshest state under the project's write lock. `mutate` returns the
 * next state (revision is assigned here) or throws a `ScrumError`; nothing is written then.
 */
export async function updateScrumState<T>(
  dataDir: string,
  expectedRevision: number,
  mutate: (current: ScrumState) => Promise<{ state: ScrumState; result: T }>,
): Promise<{ state: ScrumState; result: T }> {
  return serialize(dataDir, async () => {
    const dir = scrumDir(dataDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(dir, { lockfilePath: join(dir, 'state.lock'), stale: STALE_MS, retries: RETRIES, realpath: false, onCompromised: () => undefined });
    } catch {
      throw new ScrumError(409, 'Scrum state is busy with another write; try again');
    }
    try {
      const current = await readScrumState(dataDir);
      if (current.revision !== expectedRevision) {
        throw new ScrumError(409, `Scrum state changed (revision ${current.revision}, you edited ${expectedRevision}); reload before saving`);
      }
      const { state, result } = await mutate(current);
      const next: ScrumState = { ...state, schemaVersion: 1, revision: current.revision + 1 };
      // Never write what the next read would reject as corrupt.
      const checked = scrumStateSchema.safeParse(next);
      const problems = checked.success ? stateProblems(next) : checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
      if (problems.length) throw new ScrumError(400, problems.join('; '));
      await writeAtomic(scrumStatePath(dataDir), next);
      return { state: next, result };
    } finally {
      await release().catch(() => undefined);
    }
  });
}

async function writeAtomic(path: string, state: ScrumState): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await renameWithRetry(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new ScrumError(503, `Scrum state could not be saved: ${(error as Error).message}`);
  }
}

async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}
