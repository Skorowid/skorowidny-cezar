import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { normalizeClaudeUsageWindows } from '../core/usage-windows.ts';
import { usageLimitMonitor } from '../workspace/usage-limit-monitor.ts';
import { RunManager, setFallbackProviderCheck } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Claude Code's `rate_limit_event` for the five-hour window. */
const claudeWindow = (utilization: number, resetsAt: number) => normalizeClaudeUsageWindows({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization, resetsAt: Math.floor(resetsAt / 1000) } } },
})!;

/**
 * The usage-limit guard through the real engine (spec 2026-11-15-usage-limit-fallback): the
 * implicit fallback, the LIMIT-LOW warning, parking below the threshold and the ramp after reset.
 */
describe('usage-limit guard', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const env = ['CEZ_DRY_RUN', 'CEZ_MOCK_LIMIT_RESET_SECONDS', 'CEZ_LIMIT_FALLBACK', 'CEZ_LIMIT_KEEP', 'CEZ_LIMIT_RAMP_SEC', 'CEZ_CODEX_BIN', 'CEZ_MOCK_PLAN_UTILIZATION'];
  const saved: Record<string, string | undefined> = {};
  const workflow: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] };

  async function until(check: () => boolean, label: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const messages = (id: string) => store.readEventsSync(id).map((event) => String(event.message ?? ''));
  const settled = (id: string) => ['done', 'review', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '');

  beforeEach(async () => {
    for (const key of env) saved[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    process.env.CEZ_CODEX_BIN = fileURLToPath(new URL('../core/__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url));
    delete process.env.CEZ_LIMIT_FALLBACK;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-limit-guard-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await exec('git', ['add', '-A'], { cwd: repoRoot });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    for (const name of ['agent-fallback.json', 'agent-accounts.json', 'usage-limits.json']) rmSync(join(cezarHomeDir(), name), { force: true });
    rmSync(join(cezarHomeDir(), 'agent-usage-holds'), { recursive: true, force: true });
    usageLimitMonitor.resetForTests();
  });

  afterEach(async () => {
    setFallbackProviderCheck(undefined);
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      await until(() => store.listRuns().every(({ id }) => !manager?.isActive(id)), 'runs to stop');
      manager.dispose();
      manager = undefined;
    }
    await store.flush?.();
    usageLimitMonitor.resetForTests();
    rmSync(join(cezarHomeDir(), 'usage-limits.json'), { force: true });
    rmSync(join(cezarHomeDir(), 'agent-usage-holds'), { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('hands an exhausted Claude task to Codex by default, on the same run, and records the exhaustion', async () => {
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'fix the bug mock:limit', worktree: false });
    await until(() => store.getRun(started.id)?.fallbackEpisode?.current !== undefined, 'fallback to reserve its successor');
    const record = store.getRun(started.id)!;
    expect(record.runner).toBe('codex');
    expect(record.fallbackEpisode?.attempted).toEqual(['claude:default', 'codex:default']);
    expect(messages(started.id).some((m) => /claude · Default reached its usage limit — codex · Default/.test(m))).toBe(true);
    expect(usageLimitMonitor.get('claude:default')).toMatchObject({ state: 'exhausted', remainingPercent: 0 });
    expect(store.listRuns()).toHaveLength(1);
  }, 40_000);

  it('waits for the reset as before when no other agent can take over', async () => {
    setFallbackProviderCheck(async (provider) => (provider === 'codex' ? 'not signed in' : null));
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'mock:limit', worktree: false });
    await until(() => store.getRun(started.id)?.autoResumeAt !== undefined, 'auto-resume to arm');
    const record = store.getRun(started.id)!;
    expect(record.status).toBe('failed');
    expect(record.fallbackEpisode).toBeUndefined();
    expect(messages(started.id)).toContain('no other agent has usage left — waiting for this account\'s reset');
  }, 40_000);

  it('warns a live task once when its account drops under the threshold', async () => {
    process.env.CEZ_MOCK_PLAN_UTILIZATION = '0.95';
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow, { task: 'mock:pause', worktree: false });
    await until(() => messages(started.id).some((m) => m.startsWith('LIMIT-LOW claude:default: warning sent')), 'LIMIT-LOW warning');
    expect(messages(started.id).filter((m) => m.startsWith('LIMIT-LOW')).length).toBe(1);
    expect(messages(started.id)).toContain('LIMIT-LOW claude:default: warning sent — keeps working until the reset');
    expect(usageLimitMonitor.get('claude:default')).toMatchObject({ state: 'low', remainingPercent: 5 });
  }, 40_000);

  it('parks all but the kept task while the account is low, then ramps the rest back after the reset', async () => {
    process.env.CEZ_LIMIT_KEEP = '1';
    process.env.CEZ_LIMIT_RAMP_SEC = '1';
    process.env.CEZ_MOCK_PLAN_UTILIZATION = '0.95';
    const resetsAt = Date.now() + 3_600_000;
    usageLimitMonitor.observe('claude:default', claudeWindow(0.95, resetsAt));
    manager = new RunManager(store, repoRoot);
    const first = manager.startRun(workflow, { task: 'one mock:done', worktree: false });
    await until(() => settled(first.id), 'kept task to finish').catch((e) => { throw new Error(`${e.message} status=${store.getRun(first.id)?.status} reason=${JSON.stringify(store.getRun(first.id)?.queueWaitReason)} msgs=${messages(first.id).join(' | ')}`); });
    const second = manager.startRun(workflow, { task: 'two mock:done', worktree: false });
    const third = manager.startRun(workflow, { task: 'three mock:done', worktree: false });
    await until(() => store.getRun(second.id)?.queueWaitReason?.kind === 'limit-low' && store.getRun(third.id)?.queueWaitReason?.kind === 'limit-low', 'parked wait reasons');
    // A kept task that finished frees no slot: the parked work waits for the reset.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(second.id)?.status).toBe('queued');
    // The kept task's own stream restated the window; the park follows the newest reset.
    const reason = store.getRun(third.id)?.queueWaitReason;
    expect(reason?.kind === 'limit-low' && Date.parse(reason.resetsAt) >= resetsAt - 1000).toBe(true);

    const startedAt = new Map<string, number>();
    store.on('run', (run) => { if (run.status === 'running' && !startedAt.has(run.id)) startedAt.set(run.id, Date.now()); });
    process.env.CEZ_MOCK_PLAN_UTILIZATION = '0.1';
    // The window reset: a fresh observation shows the allowance is back.
    usageLimitMonitor.observe('claude:default', claudeWindow(0.01, Date.now() + 5 * 3_600_000));
    await until(() => settled(second.id) && settled(third.id), 'parked tasks to come back', 30_000);
    const times = [startedAt.get(second.id)!, startedAt.get(third.id)!].sort((a, b) => a - b);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
    expect(store.getRun(second.id)?.queueWaitReason).toBeUndefined();
    expect([...messages(second.id), ...messages(third.id)].some((m) => m.includes('has reset — resuming parked work one task at a time'))).toBe(true);
  }, 60_000);
});
