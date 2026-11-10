/**
 * Host memory guard. Under a soft cgroup limit (systemd MemoryHigh) nothing is ever killed: the
 * kernel throttles and swaps, and the whole machine can stall. The per-task `memoryLimitMb` guard
 * ships off, and a per-task limit cannot see several tasks, or a job beside cezar, adding up.
 *
 * This module only measures: how much memory is left for the tasks — on the host and inside every
 * limited cgroup cezar runs in — and which task to pause when it runs out. Linux only; elsewhere
 * (and on any read failure) it reports nothing, so the guard degrades to off.
 *
 * @author Skorowid
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Default floor: act when less than this share of a memory budget is left. */
export const DEFAULT_GUARD_PCT = 10;

/** One memory budget: the host, or one cgroup with a hard or soft limit. */
export interface MemoryBudget {
  label: string;
  totalBytes: number;
  availableBytes: number;
}

/** `CEZ_HOST_MEMORY_GUARD_PCT`: 0 turns the guard off; anything unparseable keeps the default. */
export function guardPercent(raw: string | undefined = process.env.CEZ_HOST_MEMORY_GUARD_PCT): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_GUARD_PCT;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value < 100 ? value : DEFAULT_GUARD_PCT;
}

export function parseMeminfo(text: string): MemoryBudget | undefined {
  const kb = (key: string): number | undefined => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return total && available !== undefined ? { label: 'host', totalBytes: total, availableBytes: available } : undefined;
}

/** The cgroup v2 path of this process (`0::/user.slice/…`), or undefined on v1 / non-Linux. */
export function parseOwnCgroup(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  return line ? line.slice(3).trim() || '/' : undefined;
}

export interface CgroupReader {
  read(path: string, file: string): string | undefined;
}

const fsReader: CgroupReader = {
  read(path, file) {
    try {
      return readFileSync(join('/sys/fs/cgroup', path, file), 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** A limit value from `memory.max`/`memory.high`; `max` (unlimited) yields undefined. */
function limitOf(text: string | undefined): number | undefined {
  const value = text?.trim();
  if (!value || value === 'max') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Every limited cgroup from this process's own up to the root. The budget is the tighter of
 * `memory.high` (throttling starts there — the stall itself) and `memory.max`; page cache the
 * kernel can drop (`inactive_file`) counts as available.
 */
export function cgroupBudgets(cgroupPath: string, reader: CgroupReader = fsReader): MemoryBudget[] {
  const budgets: MemoryBudget[] = [];
  let path = cgroupPath;
  for (let depth = 0; depth < 32; depth += 1) {
    const high = limitOf(reader.read(path, 'memory.high'));
    const max = limitOf(reader.read(path, 'memory.max'));
    const limit = high !== undefined && max !== undefined ? Math.min(high, max) : high ?? max;
    const current = Number(reader.read(path, 'memory.current')?.trim());
    if (limit !== undefined && Number.isFinite(current)) {
      const inactive = /^inactive_file (\d+)$/m.exec(reader.read(path, 'memory.stat') ?? '');
      const reclaimable = inactive ? Number(inactive[1]) : 0;
      budgets.push({ label: `cgroup ${path}`, totalBytes: limit, availableBytes: Math.max(0, limit - current + reclaimable) });
    }
    if (path === '/' || path === '') break;
    path = path.slice(0, path.lastIndexOf('/')) || '/';
  }
  return budgets;
}

/** Every budget this process lives under, read fresh. Empty off Linux or on any failure. */
export function readMemoryBudgets(): MemoryBudget[] {
  if (process.platform !== 'linux') return [];
  const budgets: MemoryBudget[] = [];
  try {
    const host = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
    if (host) budgets.push(host);
  } catch {
    // no /proc: no host budget
  }
  try {
    const own = parseOwnCgroup(readFileSync('/proc/self/cgroup', 'utf8'));
    if (own) budgets.push(...cgroupBudgets(own));
  } catch {
    // no cgroup v2: host only
  }
  return budgets;
}

/** The budget with the smallest share left, when it is under `pct` percent. */
export function exhaustedBudget(budgets: readonly MemoryBudget[], pct: number): MemoryBudget | undefined {
  if (pct <= 0) return undefined;
  let worst: MemoryBudget | undefined;
  for (const budget of budgets) {
    if (budget.totalBytes <= 0) continue;
    const share = (budget.availableBytes / budget.totalBytes) * 100;
    if (share < pct && (!worst || share < (worst.availableBytes / worst.totalBytes) * 100)) worst = budget;
  }
  return worst;
}

/** The task to pause: the largest process tree. Ties keep the first seen. */
export function largestRun(snapshot: Readonly<Record<string, { rssBytes: number }>>, eligible: (runId: string) => boolean): string | undefined {
  let best: string | undefined;
  let bestBytes = -1;
  for (const [runId, usage] of Object.entries(snapshot)) {
    if (!eligible(runId) || usage.rssBytes <= bestBytes) continue;
    best = runId;
    bestBytes = usage.rssBytes;
  }
  return best;
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
