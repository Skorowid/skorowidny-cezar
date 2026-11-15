import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usageLimitsResponseSchema } from '@open-mercato/cezar-contract';
import { normalizeCodexUsageWindows } from '../core/usage-windows.ts';
import { RunStore } from '../runs/store.ts';
import { usageLimitMonitor } from '../workspace/usage-limit-monitor.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

// Spec 2026-11-15-usage-limit-fallback. Author: Skorowid.
describe('workspace usage-limits API', () => {
  const savedHome = process.env.CEZ_HOME;
  let base: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cez-limits-api-'));
    process.env.CEZ_HOME = join(base, 'cezar-home');
    const repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    usageLimitMonitor.resetForTests();
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: 'test' });
  });

  afterEach(() => {
    store.flush();
    usageLimitMonitor.resetForTests();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(base, { recursive: true, force: true });
  });

  it('reports the configured thresholds and every account the runners have reported', async () => {
    const empty = usageLimitsResponseSchema.parse(await (await apiRequest(app, '/api/v1/workspace/usage-limits')).json());
    expect(empty).toMatchObject({ lowPercent: 10, keepRunning: 2, rampSeconds: 120, accounts: [] });
    const resetsAt = Math.floor((Date.now() + 3_600_000) / 1000);
    usageLimitMonitor.observe('codex:default', normalizeCodexUsageWindows({ rateLimits: { primary: { usedPercent: 93, resetsAt } } }));
    const res = await apiRequest(app, '/api/v1/workspace/usage-limits');
    expect(res.status).toBe(200);
    const body = usageLimitsResponseSchema.parse(await res.json());
    expect(body.accounts).toEqual([expect.objectContaining({ account: 'codex:default', state: 'low', remainingPercent: 7, resetsAt: resetsAt * 1000 })]);
  });
});
