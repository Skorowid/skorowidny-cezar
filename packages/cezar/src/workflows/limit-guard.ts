/**
 * Pure policy for running low on a usage limit (spec 2026-11-15-usage-limit-fallback): which tasks
 * keep working, what each is told, and the order parked work returns in after the reset.
 *
 * @author Skorowid
 */
import type { RunRecord } from '../runs/store.ts';

type TreeRun = Pick<RunRecord, 'id' | 'createdAt'> & { dispatch?: { parentRunId?: string; rootRunId?: string } };
export type TreeRole = 'root' | 'supervisor' | 'task';

/** A root owns a tree, a supervisor is a child that dispatched children of its own. */
export function treeRole(run: TreeRun, all: readonly TreeRun[]): TreeRole {
  const hasChildren = all.some((other) => other.dispatch?.parentRunId === run.id);
  if (!hasChildren) return 'task';
  return run.dispatch?.parentRunId ? 'supervisor' : 'root';
}

const ROLE_ORDER: Record<TreeRole, number> = { root: 0, supervisor: 1, task: 2 };

/**
 * The account's tasks, most important first: tree roots, then supervisors, then the rest, each
 * oldest first. The first `keep` keep working while the account is low.
 */
export function rankByImportance<T extends TreeRun>(runs: readonly T[], all: readonly TreeRun[]): T[] {
  return [...runs].sort((a, b) =>
    ROLE_ORDER[treeRole(a, all)] - ROLE_ORDER[treeRole(b, all)] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export const formatUtcTime = (at: number): string =>
  `${new Date(at).toISOString().slice(11, 16)} UTC`;

export interface LimitLowMessage {
  account: string;
  remainingPercent: number | null;
  resetsAt: number | null;
  /** null: the recipient owns tasks on the account but runs on another one itself. */
  keepsRunning: boolean | null;
  keep: number;
  /** For a root or supervisor: its descendants on the same account. */
  tree?: Array<{ id: string; title: string; status: string }>;
}

/** The engine's LIMIT-LOW note, delivered into each affected task's session. */
export function limitLowText(m: LimitLowMessage): string {
  const left = m.remainingPercent === null ? 'little' : `~${Math.round(m.remainingPercent)}%`;
  const reset = m.resetsAt === null ? 'reset time unknown' : `resets at ${formatUtcTime(m.resetsAt)}`;
  const lines = [
    `LIMIT-LOW ${m.account}: ${left} of the usage limit left, ${reset}.`,
    m.keepsRunning === null
      ? 'Your own agent runs on another account, but tasks you dispatched use this one.'
      : m.keepsRunning
      ? `You are one of at most ${m.keep} task(s) on this account that keep working until the reset: finish the most important work first, and save it often (commit, push your branch, \`node "$CEZ_BIN" handoff resume\`).`
      : 'Save your work now: commit, push your branch, and update the handoff (`node "$CEZ_BIN" handoff resume "<what is done, what is next>"`). Then end your turn — cezar holds new work on this account until the reset and resumes it gradually afterwards.',
  ];
  if (m.tree) {
    lines.push(m.tree.length
      ? `Your tasks on this account (${m.tree.length}):\n${m.tree.map((t) => `- ${t.id.slice(0, 8)} ${t.status} — ${t.title}`).join('\n')}\nOrganize the remaining work to minimize usage: let only the most important ones finish, have the rest save and push, and dispatch nothing new on this account before the reset.`
      : 'None of your dispatched tasks run on this account. Dispatch nothing new on it before the reset; another runner (`--runner`) still has its own allowance.');
  }
  return lines.join('\n');
}

export interface ParkedEntry { id: string; important: boolean; parkedAt: number }

/** After the reset: the parked important tasks first, the ones that parked last before the rest. */
export function rampOrder<T extends ParkedEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Number(b.important) - Number(a.important) || b.parkedAt - a.parkedAt || a.id.localeCompare(b.id));
}
