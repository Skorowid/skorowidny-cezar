import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pixelGpuQueueSchema, pixelJobListSchema, pixelJobSchema, pixelStudioStatusSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

// Fork feature (docs/skorowidny-cezar/pixel-studio.md). Author: Skorowid.
describe('Pixel Studio API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  let base: string;
  let repoRoot: string;
  let forge: string;
  let store: RunStore;
  let app: Hono;

  const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cez-pixel-api-'));
    process.env.CEZ_HOME = join(base, 'cezar-home');
    delete process.env.CEZ_REMOTE;
    repoRoot = join(base, 'repo');
    forge = join(base, 'PixelArt');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    mkdirSync(join(forge, 'tools', 'pixelforge'), { recursive: true });
    mkdirSync(join(forge, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(forge, 'tools', 'pixelforge', 'mcp_launcher.py'), '');
    writeFileSync(join(forge, '.venv', 'bin', 'python'), '');
    const job = join(repoRoot, 'assets', 'jobs', 'job1');
    mkdirSync(join(job, 'out'), { recursive: true });
    writeFileSync(join(job, 'job.json'), JSON.stringify({
      schema: 'pixelforge.job/1', id: 'job1', tool: 'animate', backend: 'codex', status: 'done',
      created: '2026-11-23T10:00:00Z', updated: '2026-11-23T10:00:00Z', params: { action: 'walk' },
      generation: [{ step: 'frames', prompt: 'p', raw: [] }], outputs: { sheet: 'out/sheet.png', json: 'out/sheet.json' },
      qa: { frames: 8 }, error: null,
    }));
    writeFileSync(join(job, 'out', 'sheet.png'), 'PNGDATA');
    writeFileSync(join(job, 'out', 'sheet.json'), '{"frames":[]}');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [{ id: 'repo', name: 'Repo', root: repoRoot, addedAt: '', lastOpenedAt: '', source: 'local' }];
    });
    app = createApp({ repoRoot, bootProjectId: 'repo', store, manager: {} as RunManager, version: 'test', pixelStudioHome: join(base, 'home') });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    rmSync(base, { recursive: true, force: true });
  });

  it('configures the PixelForge home and connects a project', async () => {
    const before = pixelStudioStatusSchema.parse(await (await apiRequest(app, '/api/v1/workspace/pixel-studio')).json());
    expect(before.installed).toBe(false);
    expect((await apiRequest(app, '/api/v1/workspace/pixel-studio', json('PUT', { home: join(base, 'none') }))).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/workspace/pixel-studio', json('PUT', { home: 'relative' }))).status).toBe(400);
    const set = await apiRequest(app, '/api/v1/workspace/pixel-studio', json('PUT', { home: forge }));
    expect(pixelStudioStatusSchema.parse(await set.json())).toMatchObject({ installed: true, home: forge });
    const on = await apiRequest(app, '/api/v1/workspace/pixel-studio/projects/repo', json('PUT', { connected: true }));
    expect(pixelStudioStatusSchema.parse(await on.json()).projects[0]?.status).toBe('connected');
    const file = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), 'utf8'));
    expect(file.mcpServers.pixelforge.args[1]).toBe(join(forge, 'tools', 'pixelforge', 'mcp_launcher.py'));
    for (const body of [{}, { connected: true, command: 'sh' }]) {
      expect((await apiRequest(app, '/api/v1/workspace/pixel-studio/projects/repo', json('PUT', body))).status).toBe(400);
    }
    expect((await apiRequest(app, '/api/v1/workspace/pixel-studio/projects/nope', json('PUT', { connected: true }))).status).toBe(404);
  });

  it('lists jobs, reads one and serves its files with a guarded path', async () => {
    const list = pixelJobListSchema.parse(await (await apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs')).json());
    expect(list.jobs.map((j) => j.id)).toEqual(['job1']);
    expect(pixelJobSchema.parse(await (await apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs/job1')).json()).tool).toBe('animate');
    const png = await apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs/job1/file?path=out/sheet.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(await png.text()).toBe('PNGDATA');
    writeFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), '{"mcpServers":{}}');
    expect((await apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs/job1/file?path=../../../.ai/cezar/mcp.local.json')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs/nojob')).status).toBe(404);
    expect([400, 404]).toContain((await apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs/..%2Fx')).status);
  });

  it('validates new jobs and refuses them while PixelForge is not configured', async () => {
    const post = (body: unknown) => apiRequest(app, '/api/v1/p/repo/pixel-studio/jobs', json('POST', body));
    expect((await post({ tool: 'sculpt' })).status).toBe(400);
    expect((await post({ tool: 'character8', description: 'x' })).status).toBe(400);
    expect((await post({ tool: 'tileset', lower: 'grass', upper: 'sand', tileSize: 20 })).status).toBe(400);
    const r = await post({ tool: 'tileset', lower: 'grass', upper: 'sand' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/not configured/);
  });

  it('lists the GPU queue', async () => {
    const q = pixelGpuQueueSchema.parse(await (await apiRequest(app, '/api/v1/p/repo/pixel-studio/gpu-queue')).json());
    expect(q.entries).toEqual([]);
  });
});
