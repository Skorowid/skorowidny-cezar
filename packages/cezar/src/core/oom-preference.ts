/**
 * Issue #1: under a shared memory limit the kernel picks its OOM victim by size, and the cockpit is
 * often the largest process in its cgroup. Raising an agent's `oom_score_adj` needs no privilege,
 * and every process the agent forks afterwards inherits it, so builds are preferred too.
 * Linux only; any failure leaves the process as it was.
 *
 * @author Skorowid
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const AGENT_OOM_SCORE_ADJ = 500;

export interface OomFs {
  read(path: string): string;
  write(path: string, value: string): void;
}

const procFs: OomFs = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, value) => writeFileSync(path, value),
};

/** Raise (never lower) `pid`'s `oom_score_adj` to `AGENT_OOM_SCORE_ADJ`. True when written. */
export function preferForOomKill(pid: number, fs: OomFs = procFs, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return false;
  const path = `/proc/${pid}/oom_score_adj`;
  try {
    if (Number(fs.read(path).trim()) >= AGENT_OOM_SCORE_ADJ) return false;
    fs.write(path, String(AGENT_OOM_SCORE_ADJ));
    return true;
  } catch {
    return false;
  }
}
