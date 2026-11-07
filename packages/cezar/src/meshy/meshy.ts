import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';
import type { MeshyProject, MeshyProjectStatus, MeshyStatus } from '@open-mercato/cezar-contract';
import { privateMcpPath } from '../core/private-mcp.ts';
import { ensureDataGitignore } from '../data-gitignore.ts';

/**
 * Meshy AI for the cockpit's global settings (fork feature; docs/skorowidny-cezar/meshy-integration.md).
 *
 * The install, the key and the launcher belong to `fork/tools/meshy_mcp.py`; this module only
 * READS their state and adds or removes the one `meshy` entry in a project's private
 * `.ai/cezar/mcp.local.json`, producing the same entry as `meshy_mcp.py register`. The key file
 * is stat'ed, never read. Paths live under the real home (`~/.local/share`, `~/.config`), not
 * `cezarHomeDir()`, because the Python tool owns them; `home` is injectable for tests.
 *
 * Author: Skorowid
 */

export const MESHY_SERVER_NAME = 'meshy';

export interface MeshyPaths {
  root: string;
  launcher: string;
  manifest: string;
  output: string;
  key: string;
}

export function meshyPaths(home: string = homedir()): MeshyPaths {
  const root = join(home, '.local', 'share', 'skorowidny-cezar', 'meshy-mcp');
  return {
    root,
    launcher: join(root, 'meshy_mcp.py'),
    manifest: join(root, 'launcher.json'),
    output: join(root, 'output.json'),
    key: join(home, '.config', 'meshy', 'meshy.env'),
  };
}

const manifestSchema = z.object({ package: z.string(), version: z.string(), node: z.string(), entry: z.string() });
const outputSchema = z.object({ dir: z.string().refine((d) => d.startsWith('/'), 'dir must be absolute') });

/** The entry `meshy_mcp.py register` writes — kept identical so the CLI's `check` accepts it. */
export function meshyEntry(paths: MeshyPaths, python: string): { type: 'stdio'; command: string; args: string[] } {
  return { type: 'stdio', command: python, args: ['-I', paths.launcher, 'run'] };
}

/** `python3` from PATH, unresolved (a minor Python upgrade keeps the entry working), like the CLI. */
export function findPython(env: NodeJS.ProcessEnv = process.env): string {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'python3');
    if (existsSync(candidate)) return candidate;
  }
  return '/usr/bin/python3';
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

type McpFile = { ok: true; data: Record<string, unknown> & { mcpServers: Record<string, unknown> } } | { ok: false; problem: string };

function parseMcpFile(text: string | null): McpFile {
  if (text === null || text.trim() === '') return { ok: true, data: { mcpServers: {} } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, problem: `mcp.local.json is not valid JSON: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: 'mcp.local.json is not an object' };
  const data = raw as Record<string, unknown>;
  const servers = data.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ok: false, problem: 'mcp.local.json "mcpServers" is not an object' };
  }
  return { ok: true, data: { ...data, mcpServers: servers as Record<string, unknown> } };
}

/** Same rule as the CLI's `entry_problem`: our launcher, `run`, nothing else. */
export function isOurEntry(paths: MeshyPaths, entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const args = e.args;
  return (
    typeof e.command === 'string' &&
    e.command.length > 0 &&
    (e.type === undefined || e.type === 'stdio') &&
    Array.isArray(args) &&
    args.length === 3 &&
    args[0] === '-I' &&
    args[1] === paths.launcher &&
    args[2] === 'run'
  );
}

export async function projectMeshyStatus(paths: MeshyPaths, root: string): Promise<{ status: MeshyProjectStatus; problem?: string }> {
  let text: string | null;
  try {
    text = await readTextOrNull(privateMcpPath(root));
  } catch (err) {
    return { status: 'broken', problem: `mcp.local.json could not be read: ${(err as Error).message}` };
  }
  const file = parseMcpFile(text);
  if (!file.ok) return { status: 'broken', problem: file.problem };
  const entry = file.data.mcpServers[MESHY_SERVER_NAME];
  if (entry === undefined) return { status: 'disconnected' };
  return isOurEntry(paths, entry)
    ? { status: 'connected' }
    : { status: 'foreign', problem: 'a "meshy" entry that does not start this machine’s launcher; edit it in Agent config' };
}

export interface MeshyProjectRef {
  id: string;
  name: string;
  root: string;
  missing: boolean;
}

export async function readMeshyStatus(
  paths: MeshyPaths,
  projects: readonly MeshyProjectRef[],
  writable: boolean,
): Promise<MeshyStatus> {
  const problems: string[] = [];
  let installed = false;
  let version: string | undefined;
  const manifestText = await readTextOrNull(paths.manifest).catch(() => null);
  if (manifestText !== null) {
    try {
      const manifest = manifestSchema.parse(JSON.parse(manifestText));
      version = manifest.version;
      installed = existsSync(paths.launcher) && existsSync(manifest.entry);
      if (!installed) problems.push('The installed server or launcher is missing; run fork/tools/meshy_mcp.py install.');
    } catch {
      problems.push('launcher.json is damaged; run fork/tools/meshy_mcp.py install.');
    }
  } else {
    problems.push('Not installed: run python3 -I fork/tools/meshy_mcp.py install in the skorowidny-cezar checkout.');
  }

  let keyPresent = false;
  let keyPrivate = false;
  try {
    const info = await stat(paths.key);
    keyPresent = info.isFile();
    keyPrivate = keyPresent && (info.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || info.uid === process.getuid());
    if (keyPresent && !keyPrivate) problems.push(`The key file is readable by others or not yours; run chmod 600 ${paths.key}.`);
  } catch {
    problems.push('No API key: run meshy_mcp.py set-key in a terminal (the key never goes through the cockpit).');
  }

  let outputDir: string | undefined;
  const outputText = await readTextOrNull(paths.output).catch(() => null);
  if (outputText !== null) {
    const parsed = outputSchema.safeParse(safeJson(outputText));
    if (parsed.success) outputDir = parsed.data.dir;
    else problems.push('output.json is damaged; run meshy_mcp.py set-output --dir <absolute dir>.');
  }

  const rows: MeshyProject[] = await Promise.all(
    projects.map(async (p) => {
      if (p.missing) return { id: p.id, name: p.name, status: 'missing' as const };
      const state = await projectMeshyStatus(paths, p.root);
      return { id: p.id, name: p.name, ...state };
    }),
  );
  return { installed, ...(version ? { version } : {}), keyPresent, keyPrivate, ...(outputDir ? { outputDir } : {}), writable, problems, projects: rows };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class MeshyRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

/**
 * Add or remove the `meshy` entry. Refuses a broken file and a foreign entry (never clobbers what
 * the user wrote), and a file that changed between read and write. Same write discipline as the
 * Agent config editor: git-ignore entry first, `0600`, unique `.cez-tmp-` name, atomic rename.
 */
export async function setProjectMeshy(paths: MeshyPaths, root: string, connected: boolean, python: string): Promise<void> {
  const path = privateMcpPath(root);
  const before = await readTextOrNull(path);
  const file = parseMcpFile(before);
  if (!file.ok) throw new MeshyRefusal(`${file.problem}; fix it in Agent config first`, 409);
  const servers = file.data.mcpServers;
  const current = servers[MESHY_SERVER_NAME];
  if (current !== undefined && !isOurEntry(paths, current)) {
    throw new MeshyRefusal('this project has its own "meshy" entry; change or remove it in Agent config', 409);
  }
  if (connected) {
    if (!existsSync(paths.manifest) || !existsSync(paths.launcher)) {
      throw new MeshyRefusal('the Meshy server is not installed on this machine', 409);
    }
    if (isOurEntry(paths, current)) return;
    servers[MESHY_SERVER_NAME] = meshyEntry(paths, python);
  } else {
    if (current === undefined) return;
    delete servers[MESHY_SERVER_NAME];
  }
  await mkdir(dirname(path), { recursive: true });
  ensureDataGitignore(root);
  const tmp = `${path}.cez-tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(file.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    if ((await readTextOrNull(path)) !== before) {
      throw new MeshyRefusal('mcp.local.json changed while it was being updated; nothing was written, try again', 409);
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
