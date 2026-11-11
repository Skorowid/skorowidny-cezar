/**
 * Build artifacts left in a finished task's worktree. A Rust `target/` alone reaches gigabytes per
 * worktree, and retention keeps several finished worktrees, so they add up to tens of gigabytes.
 *
 * Only a directory that declares itself a cache is removed: it holds a valid `CACHEDIR.TAG`
 * (https://bford.info/cachedir/ — Cargo writes one into every `target/`) and git confirms it is
 * ignored. Sources, untracked work and anything unmarked are never touched. Deletion runs at idle
 * I/O priority where `ionice` exists, so freeing space does not stall a busy disk.
 *
 * @author Skorowid
 */
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
/** Deep enough for `crate/target` and `packages/x/target`, shallow enough to stay cheap. */
const MAX_DEPTH = 3;
const SKIP = new Set(['.git', 'node_modules']);

/** `CEZ_CLEAN_BUILD_ARTIFACTS=0` keeps every finished worktree's caches. */
export function buildArtifactCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_CLEAN_BUILD_ARTIFACTS !== '0';
}

async function isCacheDir(dir: string): Promise<boolean> {
  try {
    return (await readFile(join(dir, 'CACHEDIR.TAG'), 'utf8')).startsWith(CACHEDIR_SIGNATURE);
  } catch {
    return false;
  }
}

/** Directories under `root` (depth ≤ 3) carrying a valid CACHEDIR.TAG. Never throws. */
export async function findCacheDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (await isCacheDir(path)) found.push(path);
      else if (depth < MAX_DEPTH) await walk(path, depth + 1);
    }
  };
  await walk(root, 1);
  return found;
}

function gitIgnores(root: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (paths.length === 0) return resolve(new Set());
    const rel = paths.map((p) => relative(root, p));
    execFile('git', ['-C', root, 'check-ignore', '--', ...rel], { timeout: 30_000 }, (_err, stdout) => {
      // Exit 1 means "none ignored"; stdout lists exactly the ignored ones either way.
      const ignored = new Set(String(stdout ?? '').split('\n').filter(Boolean));
      resolve(new Set(paths.filter((_, i) => ignored.has(rel[i]!))));
    });
  });
}

function removeIdle(path: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('ionice', ['-c', '3', 'nice', '-n', '19', 'rm', '-rf', '--', path], { stdio: 'ignore' });
    child.on('error', () => void rm(path, { recursive: true, force: true }).then(resolve, () => resolve()));
    child.on('close', () => resolve());
  });
}

/**
 * Remove every git-ignored cache directory in a worktree. Returns the removed paths relative to
 * the worktree. Never throws.
 */
export async function cleanBuildArtifacts(worktree: string): Promise<string[]> {
  const candidates = await findCacheDirs(worktree);
  const ignored = await gitIgnores(worktree, candidates);
  const removed: string[] = [];
  for (const dir of candidates) {
    if (!ignored.has(dir)) continue;
    await removeIdle(dir);
    removed.push(relative(worktree, dir));
  }
  return removed;
}
