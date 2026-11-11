import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emitUsageForTest } from '../core/process-usage.ts';
import { listTaskProcesses } from '../core/task-processes.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import {
  cgroupBudgets,
  DEFAULT_GUARD_PCT,
  exhaustedBudget,
  guardPercent,
  largestRun,
  parseMeminfo,
  parseOwnCgroup,
  type CgroupReader,
} from './memory-pressure.ts';
import { __resetHostMemoryGuardForTests, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

// Several agents under a soft MemoryHigh plus a large job beside them can exhaust the host without
// anything being paused or killed.

const GB = 1024 ** 3;

describe('memory-pressure helpers', () => {
  it('reads MemTotal/MemAvailable', () => {
    const text = 'MemTotal:       41943040 kB\nMemFree:  100 kB\nMemAvailable:    3774873 kB\n';
    expect(parseMeminfo(text)).toEqual({ label: 'host', totalBytes: 41943040 * 1024, availableBytes: 3774873 * 1024 });
    expect(parseMeminfo('garbage')).toBeUndefined();
  });

  it('finds the v2 cgroup path', () => {
    expect(parseOwnCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/cezar.service\n'))
      .toBe('/user.slice/user-1000.slice/user@1000.service/app.slice/cezar.service');
    expect(parseOwnCgroup('12:memory:/foo\n')).toBeUndefined();
  });

  it('walks every limited ancestor, counting reclaimable page cache and the tighter of high/max', () => {
    const files: Record<string, string> = {
      '/a/b/cezar.service:memory.high': `${32 * GB}\n`,
      '/a/b/cezar.service:memory.max': 'max\n',
      '/a/b/cezar.service:memory.current': `${31 * GB}\n`,
      '/a/b/cezar.service:memory.stat': `anon 1\ninactive_file ${GB / 2}\n`,
      '/a/b:memory.max': `${34 * GB}\n`,
      '/a/b:memory.current': `${33 * GB}\n`,
      '/a:memory.max': 'max\n',
    };
    const reader: CgroupReader = { read: (path, file) => files[`${path}:${file}`] };
    expect(cgroupBudgets('/a/b/cezar.service', reader)).toEqual([
      { label: 'cgroup /a/b/cezar.service', totalBytes: 32 * GB, availableBytes: 1.5 * GB },
      { label: 'cgroup /a/b', totalBytes: 34 * GB, availableBytes: 1 * GB },
    ]);
  });

  it('reports the budget with the smallest share under the floor', () => {
    const host = { label: 'host', totalBytes: 40 * GB, availableBytes: 3.6 * GB }; // 9 %
    const slice = { label: 'cgroup', totalBytes: 34 * GB, availableBytes: 1 * GB }; // 3 %
    expect(exhaustedBudget([host, slice], 10)).toBe(slice);
    expect(exhaustedBudget([{ ...host, availableBytes: 20 * GB }], 10)).toBeUndefined();
    expect(exhaustedBudget([host], 0)).toBeUndefined();
  });

  it('defaults the floor to 10 % and lets 0 turn it off', () => {
    expect(guardPercent(undefined)).toBe(DEFAULT_GUARD_PCT);
    expect(guardPercent('0')).toBe(0);
    expect(guardPercent('15')).toBe(15);
    expect(guardPercent('nonsense')).toBe(DEFAULT_GUARD_PCT);
  });

  it('picks the largest eligible tree', () => {
    const snapshot = { a: { rssBytes: 5 * GB }, b: { rssBytes: 9 * GB }, c: { rssBytes: 12 * GB } };
    expect(largestRun(snapshot, (id) => id !== 'c')).toBe('b');
    expect(largestRun(snapshot, () => false)).toBeUndefined();
  });
});

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SINGLE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

describe('RunManager host memory guard (default on)', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const ids: string[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-memguard-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_HOST_MEMORY_GUARD_PCT']) saved[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_HOST_MEMORY_GUARD_PCT;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    for (const id of ids.splice(0)) manager.cancel(id);
    manager.dispose();
    __resetHostMemoryGuardForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const notes = (id: string): string[] => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; message?: string })
      .filter((e) => e.type === 'note').map((e) => String(e.message));
  };

  async function parkedRun(): Promise<string> {
    const record = manager.startRun(SINGLE_STEP, { task: 'say hi', worktree: false });
    ids.push(record.id);
    await waitFor(record.id, (r) => r?.status === 'waiting');
    return record.id;
  }

  it('pauses the task with the largest process tree when the machine runs out of memory', async () => {
    const id = await parkedRun();
    __resetHostMemoryGuardForTests([{ label: 'host', totalBytes: 40 * GB, availableBytes: 2 * GB }]);
    emitUsageForTest({ [id]: { cpuPct: 1, rssBytes: 12 * GB, procCount: 3 } });
    await waitFor(id, (r) => r?.status !== 'waiting');
    expect(notes(id).some((m) => m.includes('running out of memory') && m.includes('2.0 GB of 40.0 GB left'))).toBe(true);
  });

  it('does nothing with memory to spare, or when CEZ_HOST_MEMORY_GUARD_PCT=0', async () => {
    const id = await parkedRun();
    __resetHostMemoryGuardForTests([{ label: 'host', totalBytes: 40 * GB, availableBytes: 20 * GB }]);
    emitUsageForTest({ [id]: { cpuPct: 1, rssBytes: 12 * GB, procCount: 3 } });
    process.env.CEZ_HOST_MEMORY_GUARD_PCT = '0';
    __resetHostMemoryGuardForTests([{ label: 'host', totalBytes: 40 * GB, availableBytes: 1 * GB }]);
    emitUsageForTest({ [id]: { cpuPct: 1, rssBytes: 12 * GB, procCount: 3 } });
    await new Promise((r) => setTimeout(r, 300));
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(notes(id).some((m) => m.includes('running out of memory'))).toBe(false);
  });

  const lifecycle = (id: string): string[] => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; message?: string })
      .filter((e) => e.type === 'lifecycle').map((e) => String(e.message));
  };

  /** What an agent does with `nohup cargo test > log &`: a detached process carrying the task id. */
  const leaveBackgroundProcess = async (taskId: string): Promise<void> => {
    spawn('setsid', ['sleep', '100001'], { env: { ...process.env, CEZ_TASK_ID: taskId }, detached: true, stdio: 'ignore' }).unref();
    await until(async () => await backgroundAlive(taskId));
  };
  const backgroundAlive = async (taskId: string): Promise<boolean> =>
    (await listTaskProcesses()).some((p) => p.taskId === taskId && p.command.includes('sleep 100001'));
  const until = async (check: () => Promise<boolean>, ms = 15_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it('never pauses a task holding a negligible share, however low memory is', async () => {
    const id = await parkedRun();
    __resetHostMemoryGuardForTests([{ label: 'host', totalBytes: 40 * GB, availableBytes: 1 * GB }], async () => new Map());
    emitUsageForTest({ [id]: { cpuPct: 1, rssBytes: 0.3 * GB, procCount: 3 } });
    await new Promise((r) => setTimeout(r, 500));
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(notes(id).some((m) => m.includes('running out of memory'))).toBe(false);
  });

  it.runIf(process.platform === 'linux')('counts detached processes by CEZ_TASK_ID: a big leftover build is stopped, the small live agent is not paused', async () => {
    const live = await parkedRun();
    const { id: builder } = store.createRun({ title: 'b', workflow: 'quick-task', task: 'x', steps: [] });
    store.updateRun(builder, { status: 'done' });
    await leaveBackgroundProcess(builder);
    __resetHostMemoryGuardForTests(
      [{ label: 'host', totalBytes: 40 * GB, availableBytes: 2 * GB }],
      async () => new Map([[builder, 15 * GB]]),
    );
    emitUsageForTest({ [live]: { cpuPct: 1, rssBytes: 3 * GB, procCount: 2 } });
    expect(await until(async () => !(await backgroundAlive(builder)))).toBe(true);
    expect(store.getRun(live)?.status).toBe('waiting');
    expect(notes(live).some((m) => m.includes('running out of memory'))).toBe(false);
  });

  describe.runIf(process.platform === 'linux')('stops the processes a task detached', () => {
    it('on a memory-guard pause', async () => {
      const id = await parkedRun();
      await leaveBackgroundProcess(id);
      __resetHostMemoryGuardForTests([{ label: 'host', totalBytes: 40 * GB, availableBytes: 2 * GB }]);
      emitUsageForTest({ [id]: { cpuPct: 1, rssBytes: 12 * GB, procCount: 3 } });
      expect(await until(async () => !(await backgroundAlive(id)))).toBe(true);
      expect(await until(async () => lifecycle(id).some((m) => m.includes('sleep 100001') && m.includes('machine memory low')))).toBe(true);
    });

    it('on cancel of a live run', async () => {
      const id = await parkedRun();
      await leaveBackgroundProcess(id);
      manager.cancel(id);
      expect(await until(async () => !(await backgroundAlive(id)), 20_000)).toBe(true);
    });
  });
});
