import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
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
    // `shutil.which` semantics: an executable regular file; relative PATH entries are skipped,
    // since the entry is started from another cwd.
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'python3');
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // not here
    }
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
  // Only an ABSENT map defaults to empty; an explicit null is broken, as the CLI and cezar read it.
  const servers = 'mcpServers' in data ? data.mcpServers : {};
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
  const env = e.env;
  const envOk =
    env === undefined ||
    (!!env && typeof env === 'object' && !Array.isArray(env) && Object.values(env).every((v) => typeof v === 'string'));
  return (
    envOk &&
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
  const { status, problem } = await projectState(paths, root);
  return problem ? { status, problem } : { status };
}

async function projectState(
  paths: MeshyPaths,
  root: string,
): Promise<{ status: MeshyProjectStatus; problem?: string; hostedProblem?: string }> {
  let text: string | null;
  try {
    text = await readTextOrNull(privateMcpPath(root));
  } catch (err) {
    return { status: 'broken', problem: `mcp.local.json could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const file = parseMcpFile(text);
  // A JSON.parse message can quote the file, and the file holds other servers' tokens.
  if (!file.ok) return { status: 'broken', problem: file.problem, hostedProblem: 'mcp.local.json is not valid' };
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
  const status = await collectMeshyStatus(paths, projects);
  // A hosted cockpit's viewer is not the machine's user: no local paths and no file contents —
  // each diagnostic carries a fixed hosted wording instead of being redacted after the fact.
  if (writable) {
    return { ...status, writable, problems: status.problems.map((p) => p.local), projects: status.projects.map((p) => withProblem(p, p.problem?.local)) };
  }
  const { outputDir: _hidden, ...rest } = status;
  return { ...rest, writable, problems: rest.problems.map((p) => p.hosted), projects: rest.projects.map((p) => withProblem(p, p.problem?.hosted)) };
}

interface Problem {
  local: string;
  hosted: string;
}

type Row = Omit<MeshyProject, 'problem'> & { problem?: Problem };

function withProblem(row: Row, problem: string | undefined): MeshyProject {
  const { problem: _p, ...rest } = row;
  return problem ? { ...rest, problem } : rest;
}

async function collectMeshyStatus(
  paths: MeshyPaths,
  projects: readonly MeshyProjectRef[],
): Promise<Omit<MeshyStatus, 'writable' | 'problems' | 'projects'> & { problems: Problem[]; projects: Row[] }> {
  const problems: Problem[] = [];
  const same = (text: string): Problem => ({ local: text, hosted: text });
  let installed = false;
  let version: string | undefined;
  const manifestText = await readTextOrNull(paths.manifest).catch(() => null);
  if (manifestText !== null) {
    try {
      const manifest = manifestSchema.parse(JSON.parse(manifestText));
      version = manifest.version;
      installed = existsSync(paths.launcher) && existsSync(manifest.entry);
      if (!installed) problems.push(same('The installed server or launcher is missing; run fork/tools/meshy_mcp.py install.'));
    } catch {
      problems.push(same('launcher.json is damaged; run fork/tools/meshy_mcp.py install.'));
    }
  } else {
    problems.push(same('Not installed: run python3 -I fork/tools/meshy_mcp.py install in the skorowidny-cezar checkout.'));
  }

  let keyPresent = false;
  let keyPrivate = false;
  try {
    const info = await stat(paths.key);
    keyPresent = info.isFile();
    keyPrivate = keyPresent && (info.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || info.uid === process.getuid());
    if (keyPresent && !keyPrivate) {
      problems.push({
        local: `The key file is readable by others or not yours; run chmod 600 ${paths.key}.`,
        hosted: 'The key file is readable by others or not yours; fix its permissions on the host.',
      });
    }
  } catch {
    problems.push(same('No API key: run meshy_mcp.py set-key in a terminal (the key never goes through the cockpit).'));
  }

  let outputDir: string | undefined;
  const outputText = await readTextOrNull(paths.output).catch(() => null);
  if (outputText !== null) {
    const parsed = outputSchema.safeParse(safeJson(outputText));
    if (parsed.success) outputDir = parsed.data.dir;
    else problems.push(same('output.json is damaged; run meshy_mcp.py set-output --dir <absolute dir>.'));
  }

  const rows: Row[] = await Promise.all(
    projects.map(async (p): Promise<Row> => {
      if (p.missing) return { id: p.id, name: p.name, status: 'missing' };
      const { status, problem, hostedProblem } = await projectState(paths, p.root);
      return { id: p.id, name: p.name, status, ...(problem ? { problem: { local: problem, hosted: hostedProblem ?? problem } } : {}) };
    }),
  );
  return { installed, ...(version ? { version } : {}), keyPresent, keyPrivate, ...(outputDir ? { outputDir } : {}), problems, projects: rows };
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
 * Agent config editor: git-ignore entry first, `0600`, unique `.cez-tmp-` name, atomic rename
 * THROUGH a symlink to its target (refused when the target is on another filesystem). Creating
 * the file is an exclusive link (fails if it appeared);
 * an existing file's check-then-rename still has a small window, as in the CLI and the editor.
 */
/** The two filesystem steps whose failure modes the tests must reach (no hard links, EXDEV). */
export interface MeshyWriteOps {
  link: (from: string, to: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

const defaultOps: MeshyWriteOps = { link, rename };

export async function setProjectMeshy(
  paths: MeshyPaths,
  root: string,
  connected: boolean,
  python: string,
  ops: MeshyWriteOps = defaultOps,
): Promise<void> {
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
  let target = path;
  try {
    target = await realpath(path);
  } catch {
    // absent: the create case writes the path itself
  }
  await mkdir(dirname(path), { recursive: true });
  ensureDataGitignore(root);
  // The temp file always sits in THIS project's git-ignored `.ai/cezar/` (pattern
  // `mcp.local.json.cez-tmp-*`), even when the file is a symlink to somewhere else.
  const tmp = `${path}.cez-tmp-${process.pid}-${randomUUID()}`;
  const text = `${JSON.stringify(file.data, null, 2)}\n`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  const stale = () => new MeshyRefusal('mcp.local.json changed while it was being updated; nothing was written, try again', 409);
  try {
    if (before === null) {
      let linked = false;
      try {
        await ops.link(tmp, target); // exclusive create
        linked = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw stale();
        // No hard links on this filesystem (exFAT, some mounts): fall back to check-then-rename.
        if ((await readTextOrNull(target)) !== null) throw stale();
      }
      if (linked) {
        await unlink(tmp).catch(() => {});
        return;
      }
    } else if ((await readTextOrNull(target)) !== before) {
      throw stale();
    }
    try {
      await ops.rename(tmp, target);
    } catch (err) {
      // A symlink target on another filesystem cannot take an atomic rename, and an in-place
      // write could leave the other servers' config half-written: refuse, the file is untouched.
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new MeshyRefusal('mcp.local.json links to another filesystem; add or remove the "meshy" entry in Agent config', 409);
      }
      throw err;
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
