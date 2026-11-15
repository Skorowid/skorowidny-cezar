import { describe, expect, it } from 'vitest';
import { limitLowText, rampOrder, rankByImportance, treeRole } from './limit-guard.ts';

const run = (id: string, createdAt: string, parentRunId?: string) =>
  ({ id, createdAt, ...(parentRunId ? { dispatch: { parentRunId, rootRunId: 'root' } } : {}) });

describe('usage-limit guard policy', () => {
  const root = run('root', '2026-11-15T10:00:00Z');
  const supervisor = run('sup', '2026-11-15T10:05:00Z', 'root');
  const leaf = run('leaf', '2026-11-15T09:00:00Z', 'sup');
  const loose = run('loose', '2026-11-15T08:00:00Z');
  const all = [root, supervisor, leaf, loose];

  it('names tree roles from the dispatch links', () => {
    expect(treeRole(root, all)).toBe('root');
    expect(treeRole(supervisor, all)).toBe('supervisor');
    expect(treeRole(leaf, all)).toBe('task');
    expect(treeRole(loose, all)).toBe('task');
  });

  it('ranks roots, then supervisors, then the rest, oldest first within a role', () => {
    const second = run('root2', '2026-11-15T09:30:00Z');
    const child2 = run('c2', '2026-11-15T09:31:00Z', 'root2');
    const everything = [...all, second, child2];
    expect(rankByImportance(everything, everything).map((r) => r.id)).toEqual(['root2', 'root', 'sup', 'loose', 'leaf', 'c2']);
  });

  it('tells a parked task to save and push, and a kept one to finish what matters', () => {
    const resetsAt = Date.parse('2026-11-15T13:00:00Z');
    const parked = limitLowText({ account: 'claude:default', remainingPercent: 9.6, resetsAt, keepsRunning: false, keep: 2 });
    expect(parked).toMatch(/^LIMIT-LOW claude:default: ~10% of the usage limit left, resets at 13:00 UTC\./);
    expect(parked).toContain('commit, push your branch');
    expect(parked).toContain('handoff resume');
    const kept = limitLowText({ account: 'codex:work', remainingPercent: 5, resetsAt, keepsRunning: true, keep: 2 });
    expect(kept).toContain('one of at most 2 task(s)');
  });

  it('gives a tree owner the reset and its tasks on the account', () => {
    const text = limitLowText({
      account: 'claude:default', remainingPercent: 8, resetsAt: Date.parse('2026-11-15T13:00:00Z'), keepsRunning: null, keep: 2,
      tree: [{ id: 'abcdef1234', title: 'Fix the parser', status: 'running' }],
    });
    expect(text).toContain('runs on another account');
    expect(text).toContain('Your tasks on this account (1):\n- abcdef12 running — Fix the parser');
    expect(text).toContain('dispatch nothing new on this account before the reset');
  });

  it('brings parked work back important first, the last to park first', () => {
    const order = rampOrder([
      { id: 'a', important: false, parkedAt: 1 },
      { id: 'b', important: true, parkedAt: 2 },
      { id: 'c', important: true, parkedAt: 5 },
      { id: 'd', important: false, parkedAt: 9 },
    ]);
    expect(order.map((e) => e.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});
