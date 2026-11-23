import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDataGitignore } from '../data-gitignore.ts';
import { privateMcpPath } from './private-mcp.ts';

/**
 * Adding or removing ONE named server in a project's private `.ai/cezar/mcp.local.json`, shared by
 * the fork's settings integrations (Meshy, Pixel Studio). Extracted unchanged from the Meshy
 * module (docs/skorowidny-cezar/meshy-integration.md): refuses a broken file and a foreign entry,
 * git-ignore entry first, `0600`, unique `.cez-tmp-` name, atomic rename THROUGH a symlink to its
 * target (refused across filesystems), exclusive link for a new file, refuses a file that changed
 * between read and write.
 *
 * Author: Skorowid
 */

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type McpFile = { ok: true; data: Record<string, unknown> & { mcpServers: Record<string, unknown> } } | { ok: false; problem: string };

export function parseMcpFile(text: string | null): McpFile {
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

/** The two filesystem steps whose failure modes the tests must reach (no hard links, EXDEV). */
export interface McpWriteOps {
  link: (from: string, to: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

export const defaultMcpWriteOps: McpWriteOps = { link, rename };

export interface SetPrivateMcpServerOptions {
  name: string;
  /** The entry to write, or undefined to remove the server. */
  next: unknown;
  /** Whether an existing entry is ours (only ours may be replaced or removed). */
  isOurs: (entry: unknown) => boolean;
  /** Called before writing a new entry; throws the caller's refusal when not installed. */
  assertInstalled?: () => void;
  /** Leave an existing entry of ours untouched even when `next` differs (Meshy's rule). */
  keepExistingOurs?: boolean;
  refuse: (message: string) => Error;
  messages: { broken: (problem: string) => string; foreign: string; stale: string; exdev: string };
  ops?: McpWriteOps;
}

export async function setPrivateMcpServer(root: string, opts: SetPrivateMcpServerOptions): Promise<void> {
  const ops = opts.ops ?? defaultMcpWriteOps;
  const path = privateMcpPath(root);
  const before = await readTextOrNull(path);
  const file = parseMcpFile(before);
  if (!file.ok) throw opts.refuse(opts.messages.broken(file.problem));
  const servers = file.data.mcpServers;
  const current = servers[opts.name];
  if (current !== undefined && !opts.isOurs(current)) throw opts.refuse(opts.messages.foreign);
  if (opts.next !== undefined) {
    opts.assertInstalled?.();
    if (current !== undefined && (opts.keepExistingOurs || JSON.stringify(current) === JSON.stringify(opts.next))) return;
    servers[opts.name] = opts.next;
  } else {
    if (current === undefined) return;
    delete servers[opts.name];
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
  const stale = () => opts.refuse(opts.messages.stale);
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
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') throw opts.refuse(opts.messages.exdev);
      throw err;
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
