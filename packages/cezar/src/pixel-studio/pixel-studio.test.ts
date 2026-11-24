import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PixelStudioRefusal,
  installFor,
  exportPixelJob,
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
    const external = writeJob(join(base, 'external'), 'other');
    symlinkSync(external, join(jobsDir(repo), 'linked'));
    await expect(resolveJobFile(repo, 'linked', 'out/sheet.png')).rejects.toMatchObject({ status: 400 });
    await expect(resolveJobFile(repo, '../x', 'a.png')).rejects.toMatchObject({ status: 400 });
    await expect(resolveJobFile(repo, 'nojob', 'a.png')).rejects.toMatchObject({ status: 404 });
    const uploads = join(repo, 'assets', 'pixel-uploads');
    mkdirSync(uploads, { recursive: true });
    symlinkSync(join(base, 'secret.png'), join(uploads, 'escape.png'));
    await expect(startJob(installFor(forge), repo, { tool: 'rotate', reference: 'upload:escape.png' })).rejects.toMatchObject({ status: 400 });
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

// Opt in to a PixelForge checkout containing the current 13-tool CLI.
const currentPkg = process.env.PIXELFORGE_TEST_PKG;
describe.skipIf(!currentPkg || !existsSync(join(realHome, '.venv', 'bin', 'python')))('current PixelForge integration', () => {
  it('creates and queues every new pipeline using its actual CLI', async () => {
    const install = { ...installFor(realHome), pkg: currentPkg! };
    const dir = join(repo, 'assets', 'pixel-uploads');
    mkdirSync(dir, { recursive: true });
    execFileSync(install.python, ['-c', 'from PIL import Image; import sys; Image.new("RGBA", (16,16), (120,50,20,255)).save(sys.argv[1])', join(dir, 'sprite.png')]);
    const ref = 'upload:sprite.png';
    const inputs = [
      { tool: 'isometric', description: 'stone floor', edgeOutline: 'outer', quality: 'hd', outline: 'black' },
      { tool: 'platformer', material: 'mossy stone', edgeOutline: 'outer' },
      { tool: 'interpolate', start: ref, end: ref, inbetweens: 2 },
      { tool: 'rotate', reference: ref, direction: 'all' },
      { tool: 'resize', reference: ref, size: 32 },
      { tool: 'vfx', description: 'magic fire', frames: 4 },
      { tool: 'tileset47', lower: 'grass', upper: 'dirt' },
    ] as const;
    for (const input of inputs) {
      const result = await startJob(install, repo, { ...input, backend: 'gpu' });
      const job = await readJob(join(jobsDir(repo), result.jobId));
      expect(job.tool).toBe(input.tool);
      expect(result.status).toBe('queued');
      expect(existsSync(join(repo, 'gpu-queue', result.jobId, 'job.json'))).toBe(true);
      if (input.tool === 'isometric') expect(job.params).toMatchObject({ edge_outline: 'outer', look: { outline: 'black' } });
    }
  }, 120_000);

  it('creates a sheet-edit interpolation from guarded job files', async () => {
    const install = { ...installFor(realHome), pkg: currentPkg! };
    const dir = writeJob(jobsDir(repo), 'source');
    execFileSync(install.python, ['-c', 'from PIL import Image; import sys; Image.new("RGBA", (32,16), (120,50,20,255)).save(sys.argv[1])', join(dir, 'out', 'sheet.png')]);
    writeFileSync(join(dir, 'out', 'sheet.json'), JSON.stringify({ frames: [0, 16].map((x) => ({ frame: { x, y: 0, w: 16, h: 16 } })) }));
    const result = await startJob(install, repo, { tool: 'interpolate', sheet: 'source/out/sheet.png', sheetJson: 'source/out/sheet.json', instruction: 'raise arms', backend: 'gpu' });
    expect((await readJob(join(jobsDir(repo), result.jobId))).tool).toBe('interpolate');
    const uploads = join(repo, 'assets', 'pixel-uploads');
    mkdirSync(uploads, { recursive: true });
    copyFileSync(join(dir, 'out', 'sheet.png'), join(uploads, 'sheet.png'));
    copyFileSync(join(dir, 'out', 'sheet.json'), join(uploads, 'sheet.json'));
    const uploaded = await startJob(install, repo, { tool: 'interpolate', sheet: 'upload:sheet.png', sheetJson: 'upload:sheet.json', instruction: 'raise arms', backend: 'gpu' });
    expect((await readJob(join(jobsDir(repo), uploaded.jobId))).tool).toBe('interpolate');
  }, 60_000);

  it('preserves existing tools and applies standard UI quality through the CLI', async () => {
    const install = { ...installFor(realHome), pkg: currentPkg! };
    const dir = join(repo, 'assets', 'pixel-uploads');
    mkdirSync(dir, { recursive: true });
    execFileSync(install.python, ['-c', 'from PIL import Image; import sys; Image.new("RGBA", (16,16), (120,50,20,255)).save(sys.argv[1])', join(dir, 'sprite.png')]);
    const ref = 'upload:sprite.png';
    const inputs = [
      { tool: 'character8', description: 'adult knight', size: 48, colors: 16, view: 'side' },
      { tool: 'animate', reference: ref, action: 'walk', frames: 4, direction: 'east', weapon: 'sword', description: 'red cloak', colors: 16 },
      { tool: 'tileset', lower: 'grass', upper: 'dirt', tileSize: 16, colors: 16 },
      { tool: 'image', description: 'forest scene', kind: 'scene', width: 32, height: 32, colors: 16 },
      { tool: 'ui', items: ['button'] as string[], theme: 'wood', size: 48, colors: 16, quality: 'standard' },
      { tool: 'edit', source: ref, instruction: 'add a hat', outline: 'lineless', shading: 'flat', detail: 'low' },
    ] as const;
    for (const input of inputs) {
      const result = await startJob(install, repo, { ...input, backend: 'gpu' });
      const job = await readJob(join(jobsDir(repo), result.jobId));
      expect(job.tool).toBe(input.tool);
      if (input.tool === 'animate') {
        const raw = JSON.parse(readFileSync(join(jobsDir(repo), result.jobId, 'job.json'), 'utf8'));
        expect(job.params.size).toBe(16);
        expect(raw.generation[0].prompt.toLowerCase()).toContain('sword');
        expect(raw.params.description).toBe('red cloak');
      }
      if (input.tool === 'ui') expect(job.params).toMatchObject({ theme: 'wood', look: { outline: 'black', shading: 'basic', detail: 'medium' } });
      if (input.tool === 'edit') {
        const raw = JSON.parse(readFileSync(join(jobsDir(repo), result.jobId, 'job.json'), 'utf8'));
        expect(raw.params.instruction).toBe('add a hat');
        expect(raw.generation[0].prompt).toContain('NO outline');
        expect(raw.generation[0].prompt).toContain('at most 2 tones');
      }
    }
    // FRD-011: without style controls an edit keeps the original look (no restyling).
    const plain = await startJob(install, repo, { tool: 'edit', source: ref, instruction: 'add a hat', backend: 'gpu' });
    const plainRaw = JSON.parse(readFileSync(join(jobsDir(repo), plain.jobId, 'job.json'), 'utf8'));
    expect(plainRaw.generation[0].prompt).toContain('Match the original style perfectly');
    expect(plainRaw.generation[0].prompt).not.toContain('BLACK');
  }, 120_000);

  it('exports a completed job to fixed job-local paths and rejects invalid states and symlinks', async () => {
    const install = { ...installFor(realHome), pkg: currentPkg! };
    const dir = writeJob(jobsDir(repo), 'done', { tool: 'isometric' });
    execFileSync(install.python, ['-c', 'from PIL import Image; import sys; Image.new("RGBA", (16,16), (120,50,20,255)).save(sys.argv[1])', join(dir, 'out', 'sheet.png')]);
    const result = await exportPixelJob(install, repo, 'done', 'web');
    expect(result.paths).toMatchObject({ image: 'export/web/atlas.png', json: 'export/web/atlas.json' });
    expect(existsSync(join(dir, result.paths.image!))).toBe(true);
    for (const format of ['godot', 'unity'] as const) {
      const exported = await exportPixelJob(install, repo, 'done', format);
      expect(Object.values(exported.paths).every((path) => existsSync(join(dir, path)))).toBe(true);
    }
    const tileDir = writeJob(jobsDir(repo), 'tiles', { tool: 'platformer', outputs: { sheet: 'out/sheet.png', json: 'out/tiles.json' } });
    copyFileSync(join(dir, 'out', 'sheet.png'), join(tileDir, 'out', 'sheet.png'));
    writeFileSync(join(tileDir, 'out', 'tiles.json'), JSON.stringify({ tile_size: 16, columns: 1, tiles: [{ id: 0 }] }));
    const tiled = await exportPixelJob(install, repo, 'tiles', 'tiled');
    expect(tiled.paths).toMatchObject({ image: 'export/tiled/tiles.png', tileset: 'export/tiled/tileset.tsx', map: 'export/tiled/demo.tmj' });
    await expect(exportPixelJob(install, repo, 'done', 'tiled')).rejects.toMatchObject({ status: 400 });
    writeJob(jobsDir(repo), 'pending', { status: 'queued' });
    await expect(exportPixelJob(install, repo, 'pending', 'web')).rejects.toMatchObject({ status: 409 });
    symlinkSync(join(base, 'outside'), join(dir, 'export', 'web', 'bad-link'));
    await expect(exportPixelJob(install, repo, 'done', 'web')).rejects.toMatchObject({ status: 400 });
  }, 60_000);
});
