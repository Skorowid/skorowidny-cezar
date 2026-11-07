import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshyRefusal, findPython, isOurEntry, meshyEntry, meshyPaths, projectMeshyStatus, readMeshyStatus, setProjectMeshy } from './meshy.ts';

let base: string;
let home: string;
let repo: string;
const PY = '/usr/bin/python3';

function install(): void {
  const p = meshyPaths(home);
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.launcher, '# launcher');
  const entry = join(p.root, 'index.js');
  writeFileSync(entry, '');
  writeFileSync(p.manifest, JSON.stringify({ package: '@meshy-ai/meshy-mcp-server', version: '0.6.9', node: '/usr/bin/node', entry }));
}

function setKey(mode = 0o600): void {
  const p = meshyPaths(home);
  mkdirSync(join(home, '.config', 'meshy'), { recursive: true });
  writeFileSync(p.key, 'MESHY_API_KEY=msy_SecretValue1234567890\n');
  chmodSync(p.key, mode);
}

const mcpFile = () => join(repo, '.ai', 'cezar', 'mcp.local.json');
const readMcp = () => JSON.parse(readFileSync(mcpFile(), 'utf8')) as { mcpServers: Record<string, unknown> };

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cez-meshy-'));
  home = join(base, 'home');
  repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('readMeshyStatus', () => {
  it('reports a fresh machine as not installed, without a key, with fixes named', async () => {
    const s = await readMeshyStatus(meshyPaths(home), [], true);
    expect(s).toMatchObject({ installed: false, keyPresent: false, keyPrivate: false, writable: true, projects: [] });
    expect(s.problems.join(' ')).toMatch(/install/);
    expect(s.problems.join(' ')).toMatch(/set-key/);
  });

  it('never returns the key, only whether its file exists and is private', async () => {
    install();
    setKey(0o644);
    const s = await readMeshyStatus(meshyPaths(home), [], true);
    expect(s).toMatchObject({ installed: true, version: '0.6.9', keyPresent: true, keyPrivate: false });
    expect(JSON.stringify(s)).not.toContain('msy_SecretValue');
    chmodSync(meshyPaths(home).key, 0o600);
    expect((await readMeshyStatus(meshyPaths(home), [], true)).keyPrivate).toBe(true);
  });

  it('shows the download directory and flags a damaged manifest or output file', async () => {
    install();
    writeFileSync(meshyPaths(home).output, JSON.stringify({ dir: '/home/u/ai-projects/mesh_outputs' }));
    expect((await readMeshyStatus(meshyPaths(home), [], true)).outputDir).toBe('/home/u/ai-projects/mesh_outputs');
    writeFileSync(meshyPaths(home).output, '{ broken');
    writeFileSync(meshyPaths(home).manifest, '[]');
    const s = await readMeshyStatus(meshyPaths(home), [], true);
    expect(s.installed).toBe(false);
    expect(s.outputDir).toBeUndefined();
    expect(s.problems.join(' ')).toMatch(/launcher\.json is damaged/);
    expect(s.problems.join(' ')).toMatch(/output\.json is damaged/);
  });

  it('lists every project with its state, a missing folder included', async () => {
    install();
    const s = await readMeshyStatus(
      meshyPaths(home),
      [
        { id: 'a', name: 'A', root: repo, missing: false },
        { id: 'b', name: 'B', root: join(base, 'gone'), missing: true },
      ],
      false,
    );
    expect(s.writable).toBe(false);
    expect(s.projects).toEqual([
      { id: 'a', name: 'A', status: 'disconnected' },
      { id: 'b', name: 'B', status: 'missing' },
    ]);
  });
});

describe('setProjectMeshy', () => {
  it('connects with the same entry the CLI writes, private and git-ignored, keeping other servers', async () => {
    install();
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(mcpFile(), JSON.stringify({ note: 'x', mcpServers: { tracker: { command: 't' } } }));
    await setProjectMeshy(meshyPaths(home), repo, true, PY);
    const data = readMcp() as { note?: string; mcpServers: Record<string, unknown> };
    expect(data.note).toBe('x');
    expect(data.mcpServers.tracker).toEqual({ command: 't' });
    expect(data.mcpServers.meshy).toEqual({ type: 'stdio', command: PY, args: ['-I', meshyPaths(home).launcher, 'run'] });
    expect(statSync(mcpFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(mcpFile(), 'utf8')).not.toContain('msy_');
    execFileSync('git', ['-C', repo, 'check-ignore', '-q', mcpFile()]); // throws when not ignored
    expect(readdirSync(join(repo, '.ai', 'cezar')).filter((n) => n.includes('cez-tmp'))).toEqual([]);
    expect((await projectMeshyStatus(meshyPaths(home), repo)).status).toBe('connected');
  });

  it('disconnects only its own entry and is idempotent both ways', async () => {
    install();
    await setProjectMeshy(meshyPaths(home), repo, true, PY);
    const first = readFileSync(mcpFile(), 'utf8');
    await setProjectMeshy(meshyPaths(home), repo, true, PY);
    expect(readFileSync(mcpFile(), 'utf8')).toBe(first);
    await setProjectMeshy(meshyPaths(home), repo, false, PY);
    expect(readMcp().mcpServers).toEqual({});
    await setProjectMeshy(meshyPaths(home), repo, false, PY);
    expect((await projectMeshyStatus(meshyPaths(home), repo)).status).toBe('disconnected');
  });

  it('refuses to connect when the server is not installed', async () => {
    await expect(setProjectMeshy(meshyPaths(home), repo, true, PY)).rejects.toBeInstanceOf(MeshyRefusal);
  });

  it('never overwrites a broken file or a foreign "meshy" entry', async () => {
    install();
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(mcpFile(), '{ broken');
    await expect(setProjectMeshy(meshyPaths(home), repo, true, PY)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(mcpFile(), 'utf8')).toBe('{ broken');
    expect((await projectMeshyStatus(meshyPaths(home), repo)).status).toBe('broken');
    const foreign = JSON.stringify({ mcpServers: { meshy: { command: 'npx', args: ['-y', '@meshy-ai/meshy-mcp-server'] } } });
    writeFileSync(mcpFile(), foreign);
    expect((await projectMeshyStatus(meshyPaths(home), repo)).status).toBe('foreign');
    await expect(setProjectMeshy(meshyPaths(home), repo, false, PY)).rejects.toThrow(/own "meshy" entry/);
    expect(readFileSync(mcpFile(), 'utf8')).toBe(foreign);
  });
});

describe('audit regressions', () => {
  it('hides local paths from a hosted cockpit', async () => {
    install();
    writeFileSync(meshyPaths(home).output, JSON.stringify({ dir: '/home/u/ai-projects/mesh_outputs' }));
    setKey(0o644);
    const s = await readMeshyStatus(meshyPaths(home), [{ id: 'a', name: 'A', root: repo, missing: false }], false);
    expect(s.outputDir).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(home);
    expect(JSON.stringify(s)).not.toContain('/home/u');
    expect(s.problems.join(' ')).toMatch(/<path>/);
  });

  it('writes through a symlinked mcp.local.json and keeps the link', async () => {
    install();
    const shared = join(base, 'shared-mcp.json');
    writeFileSync(shared, JSON.stringify({ mcpServers: { tracker: { command: 't' } } }));
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    symlinkSync(shared, mcpFile());
    await setProjectMeshy(meshyPaths(home), repo, true, PY);
    expect(lstatSync(mcpFile()).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(shared, 'utf8')).mcpServers)).toEqual(['tracker', 'meshy']);
  });

  it('treats a malformed env as foreign and never deletes it', async () => {
    install();
    const p = meshyPaths(home);
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    for (const env of [null, [], { A: 1 }]) {
      const text = JSON.stringify({ mcpServers: { meshy: { ...meshyEntry(p, PY), env } } });
      writeFileSync(mcpFile(), text);
      expect((await projectMeshyStatus(p, repo)).status, JSON.stringify(env)).toBe('foreign');
      await expect(setProjectMeshy(p, repo, false, PY)).rejects.toBeInstanceOf(MeshyRefusal);
      expect(readFileSync(mcpFile(), 'utf8')).toBe(text);
    }
    expect(isOurEntry(p, { ...meshyEntry(p, PY), env: { A: 'b' } })).toBe(true);
  });

  it('treats "mcpServers": null as broken and keeps the bytes', async () => {
    install();
    mkdirSync(join(repo, '.ai', 'cezar'), { recursive: true });
    writeFileSync(mcpFile(), '{"mcpServers": null}');
    expect((await projectMeshyStatus(meshyPaths(home), repo)).status).toBe('broken');
    await expect(setProjectMeshy(meshyPaths(home), repo, true, PY)).rejects.toThrow(/not an object/);
    expect(readFileSync(mcpFile(), 'utf8')).toBe('{"mcpServers": null}');
  });

  it('finds an executable python3 on absolute PATH entries only', () => {
    const bad = join(base, 'bad');
    const good = join(base, 'good');
    mkdirSync(join(bad, 'python3'), { recursive: true }); // a directory, not a file
    mkdirSync(good);
    const noexec = join(base, 'noexec');
    mkdirSync(noexec);
    writeFileSync(join(noexec, 'python3'), '');
    writeFileSync(join(good, 'python3'), '#!/bin/sh\n');
    chmodSync(join(good, 'python3'), 0o755);
    expect(findPython({ PATH: ['relative', bad, noexec, good].join(':') })).toBe(join(good, 'python3'));
    expect(findPython({ PATH: '' })).toBe('/usr/bin/python3');
  });
});

describe('isOurEntry', () => {
  it('matches the launcher entry exactly, as the CLI check does', () => {
    const p = meshyPaths(home);
    const good = meshyEntry(p, PY);
    expect(isOurEntry(p, good)).toBe(true);
    expect(isOurEntry(p, { ...good, type: undefined })).toBe(true);
    for (const bad of [null, 'x', [], {}, { ...good, command: '' }, { ...good, type: 'http' }, { ...good, args: [...good.args, '--output-dir', '/x'] }]) {
      expect(isOurEntry(p, bad)).toBe(false);
    }
  });
});
