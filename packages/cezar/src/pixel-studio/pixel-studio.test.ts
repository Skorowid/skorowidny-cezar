import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PixelStudioRefusal,
  installFor,
  isOurPixelEntry,
  jobsDir,
  listJobs,
  pixelEntry,
  pixelStudioPaths,
  readGpuQueue,
  readJob,
  readPixelHome,
  readPixelStudioStatus,
  resolveJobFile,
  setPixelHome,
  setProjectPixelStudio,
  startJob,
  syncGpuQueue,
} from './pixel-studio.ts';

// Fork feature (docs/skorowidny-cezar/pixel-studio.md). Author: Skorowid.

let base: string;
let home: string;
let forge: string;
let repo: string;

function fakeInstall(dir: string) {
  mkdirSync(join(dir, 'tools', 'pixelforge'), { recursive: true });
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'pixelforge', 'mcp_launcher.py'), '');
  writeFileSync(join(dir, '.venv', 'bin', 'python'), '');
}

function writeJob(root: string, id: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(
    join(dir, 'job.json'),
    JSON.stringify({
      schema: 'pixelforge.job/1', id, tool: 'character8', backend: 'codex', status: 'done',
      created: '2026-11-23T10:00:00Z', updated: '2026-11-23T10:01:00Z', params: { size: 48 },
      generation: [{ step: 'turnaround', prompt: 'p', raw: ['raw/turnaround_0.png'] }],
      outputs: { sheet: 'out/sheet.png', frames: ['out/frames/000.png'], preview: 'out/preview.png' },
      qa: { frames: 8 }, error: null, ...extra,
    }),
  );
  writeFileSync(join(dir, 'out', 'sheet.png'), 'PNG');
  return dir;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cez-pixel-'));
  home = join(base, 'home');
  forge = join(base, 'PixelArt');
  repo = join(base, 'repo');
  mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
  fakeInstall(forge);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('config and status', () => {
  it('stores the PixelForge home only when the install is complete', async () => {
    const paths = pixelStudioPaths(home);
    await expect(setPixelHome(paths, join(base, 'nothing'))).rejects.toBeInstanceOf(PixelStudioRefusal);
    expect(await readPixelHome(paths)).toBeNull();
    await setPixelHome(paths, forge);
    expect(await readPixelHome(paths)).toBe(forge);
  });

  it('reports install, tools on PATH and project states; hides paths when hosted', async () => {
    const paths = pixelStudioPaths(home);
    await setPixelHome(paths, forge);
    const bin = join(base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    const refs = [{ id: 'repo', name: 'Repo', root: repo, missing: false }, { id: 'gone', name: 'Gone', root: join(base, 'gone'), missing: true }];
    const local = await readPixelStudioStatus(paths, refs, true, { PATH: bin });
    expect(local).toMatchObject({ installed: true, home: forge, codex: true, aseprite: false, writable: true });
    expect(local.projects.map((p) => p.status)).toEqual(['disconnected', 'missing']);
    const hosted = await readPixelStudioStatus(paths, refs, false, { PATH: bin });
    expect(hosted.home).toBeUndefined();
  });
});

describe('private MCP entry', () => {
  it('connects, is idempotent, follows a new home and disconnects', async () => {
    const paths = pixelStudioPaths(home);
    await setPixelHome(paths, forge);
    await setProjectPixelStudio(paths, repo, true);
    const file = () => JSON.parse(readFileSync(join(repo, '.ai/cezar/mcp.local.json'), 'utf8'));
    expect(file().mcpServers.pixelforge).toEqual(pixelEntry(installFor(forge), repo));
    expect(file().mcpServers.pixelforge.env.PIXELFORGE_JOBS).toBe(jobsDir(repo));
    await setProjectPixelStudio(paths, repo, true);
    const other = join(base, 'Other');
    fakeInstall(other);
    await setPixelHome(paths, other);
    await setProjectPixelStudio(paths, repo, true);
    expect(file().mcpServers.pixelforge.command).toBe(join(other, '.venv', 'bin', 'python'));
    await setProjectPixelStudio(paths, repo, false);
    expect(file().mcpServers.pixelforge).toBeUndefined();
  });

  it('keeps other servers and refuses a foreign entry or a missing install', async () => {
    const paths = pixelStudioPaths(home);
    writeFileSync(join(repo, '.ai/cezar/mcp.local.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, pixelforge: { command: 'sh', args: ['-c', 'x'] } } }));
    await setPixelHome(paths, forge);
    await expect(setProjectPixelStudio(paths, repo, true)).rejects.toThrow(/own "pixelforge" entry/);
    writeFileSync(join(repo, '.ai/cezar/mcp.local.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    rmSync(join(forge, '.venv'), { recursive: true });
    await expect(setProjectPixelStudio(paths, repo, true)).rejects.toThrow(/venv python/);
    fakeInstall(forge);
    await setProjectPixelStudio(paths, repo, true);
    const file = JSON.parse(readFileSync(join(repo, '.ai/cezar/mcp.local.json'), 'utf8'));
    expect(Object.keys(file.mcpServers).sort()).toEqual(['other', 'pixelforge']);
  });

  it('recognises only the launcher entry', () => {
    expect(isOurPixelEntry(pixelEntry(installFor(forge), repo))).toBe(true);
    expect(isOurPixelEntry({ command: 'python', args: ['-I', '/x/evil.py'] })).toBe(false);
    expect(isOurPixelEntry(null)).toBe(false);
  });
});

describe('jobs', () => {
  it('lists valid jobs newest first and reports broken ones', async () => {
    const root = jobsDir(repo);
    writeJob(root, '20261123T100000-character8-aaaaaa');
    writeJob(root, '20261123T110000-tileset-bbbbbb', { tool: 'tileset' });
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'job.json'), '{');
    const list = await listJobs(repo);
    expect(list.jobs.map((j) => j.id)).toEqual(['20261123T110000-tileset-bbbbbb', '20261123T100000-character8-aaaaaa']);
    expect(list.problems).toEqual(['job broken: job.json is not valid']);
    const job = await readJob(join(root, '20261123T100000-character8-aaaaaa'));
    expect(job.raw).toEqual(['raw/turnaround_0.png']);
    expect(job.outputs.frames).toEqual(['out/frames/000.png']);
  });

  it('serves only files inside the job, of known types', async () => {
    const dir = writeJob(jobsDir(repo), 'job1');
    writeFileSync(join(base, 'secret.png'), 'x');
    symlinkSync(join(base, 'secret.png'), join(dir, 'out', 'link.png'));
    writeFileSync(join(dir, 'out', 'run.sh'), 'x');
    expect((await resolveJobFile(repo, 'job1', 'out/sheet.png')).type).toBe('image/png');
    for (const [rel, status] of [['../../../../secret.png', 400], ['../../secret.png', 404], ['out/link.png', 400], ['out/run.sh', 400], ['/etc/passwd', 400], ['out/none.png', 404]] as const) {
      await expect(resolveJobFile(repo, 'job1', rel)).rejects.toMatchObject({ status });
    }
    await expect(resolveJobFile(repo, '../x', 'a.png')).rejects.toMatchObject({ status: 400 });
    await expect(resolveJobFile(repo, 'nojob', 'a.png')).rejects.toMatchObject({ status: 404 });
  });
});

describe('GPU queue', () => {
  it('reads queue entries', async () => {
    writeJob(join(repo, 'gpu-queue'), 'q1', { status: 'queued', backend: 'gpu' });
    expect((await readGpuQueue(repo)).entries).toEqual([{ id: 'q1', tool: 'character8', status: 'queued', error: null }]);
    expect((await readGpuQueue(join(base, 'none'))).entries).toEqual([]);
  });

  it('pulls, commits and pushes only gpu-queue; skips the push when nothing changed', async () => {
    const calls: string[][] = [];
    let staged = 'gpu-queue/q1/job.json\n';
    const git = async (args: string[]) => {
      calls.push(args);
      return args[0] === 'diff' ? staged : '';
    };
    expect((await syncGpuQueue(repo, git)).ok).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(['pull', 'add', 'diff', 'commit', 'push']);
    expect(calls[3]).toContain('gpu-queue');
    calls.length = 0;
    staged = '';
    const r = await syncGpuQueue(repo, git);
    expect(calls.map((c) => c[0])).toEqual(['pull', 'add', 'diff']);
    expect(r.log).toContain('nothing to push');
  });

  it('reports a failed pull without pushing', async () => {
    const calls: string[] = [];
    const git = async (args: string[]) => {
      calls.push(args[0] ?? '');
      if (args[0] === 'pull') throw Object.assign(new Error('x'), { stderr: 'CONFLICT' });
      return '';
    };
    const r = await syncGpuQueue(repo, git);
    expect(r).toMatchObject({ ok: false });
    expect(r.log).toContain('CONFLICT');
    expect(calls).toEqual(['pull']);
  });
});

// Integration with the real PixelForge checkout when it is present on this machine.
const realHome = process.env.PIXELFORGE_HOME ?? join(homedir(), 'ai-projects', 'PixelArt_Skorowid_Games');
describe.skipIf(!existsSync(join(realHome, '.venv', 'bin', 'python')))('real PixelForge', () => {
  it('creates a GPU tileset job and queues it without calling a generator', async () => {
    const started = await startJob(installFor(realHome), repo, { tool: 'tileset', lower: 'grass', upper: 'sand', tileSize: 16, colors: 8, backend: 'gpu' });
    expect(started.status).toBe('queued');
    expect(existsSync(join(repo, 'gpu-queue', started.jobId, 'job.json'))).toBe(true);
    expect(existsSync(join(jobsDir(repo), started.jobId, 'inputs', 'terrain_mask.png'))).toBe(true);
    const list = await listJobs(repo);
    expect(list.jobs[0]).toMatchObject({ id: started.jobId, tool: 'tileset', backend: 'gpu' });
  }, 60_000);
});
