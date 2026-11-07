import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meshyStatusSchema } from '@open-mercato/cezar-contract';
import { meshyPaths } from '../meshy/meshy.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

// Fork feature (docs/skorowidny-cezar/meshy-integration.md). Author: Skorowid.
describe('workspace Meshy API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  let base: string;
  let repoRoot: string;
  let meshyHome: string;
  let store: RunStore;
  let app: Hono;

  const put = (projectId: string, body: unknown) =>
    apiRequest(app, `/api/v1/workspace/meshy/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cez-meshy-api-'));
    process.env.CEZ_HOME = join(base, 'cezar-home');
    delete process.env.CEZ_REMOTE;
    repoRoot = join(base, 'repo');
    meshyHome = join(base, 'home');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const p = meshyPaths(meshyHome);
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.launcher, '');
    writeFileSync(join(p.root, 'index.js'), '');
    writeFileSync(p.manifest, JSON.stringify({ package: 'm', version: '0.6.9', node: '/n', entry: join(p.root, 'index.js') }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [
        { id: 'repo', name: 'Repo', root: repoRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
        { id: 'gone', name: 'Gone', root: join(base, 'gone'), addedAt: '', lastOpenedAt: '', source: 'local' },
      ];
    });
    app = createApp({ repoRoot, bootProjectId: 'repo', store, manager: {} as RunManager, version: 'test', meshyHome });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    rmSync(base, { recursive: true, force: true });
  });

  it('answers the contract shape with every registered project', async () => {
    const response = await apiRequest(app, '/api/v1/workspace/meshy');
    expect(response.status).toBe(200);
    const body = meshyStatusSchema.parse(await response.json());
    expect(body).toMatchObject({ installed: true, version: '0.6.9', keyPresent: false, writable: true });
    expect(body.projects.map((p) => [p.id, p.status])).toEqual([
      ['repo', 'disconnected'],
      ['gone', 'missing'],
    ]);
  });

  it('connects and disconnects a project through its private MCP file', async () => {
    const on = await put('repo', { connected: true });
    expect(on.status).toBe(200);
    expect(meshyStatusSchema.parse(await on.json()).projects[0]?.status).toBe('connected');
    const file = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), 'utf8'));
    expect(file.mcpServers.meshy.args).toEqual(['-I', meshyPaths(meshyHome).launcher, 'run']);
    const off = await put('repo', { connected: false });
    expect(meshyStatusSchema.parse(await off.json()).projects[0]?.status).toBe('disconnected');
  });

  it('accepts only { connected } — command, args and paths stay server-owned', async () => {
    for (const body of [{}, { connected: 'yes' }, { connected: true, command: 'sh' }, { connected: true, args: ['x'] }]) {
      expect((await put('repo', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers 404 for an unknown project and 409 for a gone folder or a broken file', async () => {
    expect((await put('nope', { connected: true })).status).toBe(404);
    expect((await put('gone', { connected: true })).status).toBe(409);
    writeFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), '{ broken');
    const broken = await put('repo', { connected: true });
    expect(broken.status).toBe(409);
    expect(readFileSync(join(repoRoot, '.ai/cezar/mcp.local.json'), 'utf8')).toBe('{ broken');
  });

  it('refuses to write on a hosted cockpit: an MCP command is code execution', async () => {
    process.env.CEZ_REMOTE = '1';
    app = createApp({ repoRoot, bootProjectId: 'repo', store, manager: {} as RunManager, version: 'test', meshyHome });
    const status = meshyStatusSchema.parse(await (await apiRequest(app, '/api/v1/workspace/meshy')).json());
    expect(status.writable).toBe(false);
    expect((await put('repo', { connected: true })).status).toBe(409);
  });
});
