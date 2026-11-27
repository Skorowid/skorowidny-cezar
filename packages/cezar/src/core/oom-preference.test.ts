import { describe, expect, it } from 'vitest';
import { AGENT_OOM_SCORE_ADJ, preferForOomKill, type OomFs } from './oom-preference.ts';

function fakeFs(initial: string): OomFs & { written: string[] } {
  const written: string[] = [];
  return { written, read: () => initial, write: (_path, value) => void written.push(value) };
}

describe('preferForOomKill (issue #1)', () => {
  it('raises an agent to the preferred OOM score on Linux', () => {
    const fs = fakeFs('0\n');
    expect(preferForOomKill(1234, fs, 'linux')).toBe(true);
    expect(fs.written).toEqual([String(AGENT_OOM_SCORE_ADJ)]);
  });

  it('never lowers a higher score, and does nothing off Linux or for a bad pid', () => {
    const high = fakeFs('800');
    expect(preferForOomKill(1234, high, 'linux')).toBe(false);
    expect(high.written).toEqual([]);
    const other = fakeFs('0');
    expect(preferForOomKill(1234, other, 'darwin')).toBe(false);
    expect(preferForOomKill(0, other, 'linux')).toBe(false);
    expect(other.written).toEqual([]);
  });

  it('swallows a vanished process', () => {
    const gone: OomFs = { read: () => { throw new Error('ENOENT'); }, write: () => {} };
    expect(preferForOomKill(1234, gone, 'linux')).toBe(false);
  });

  it.runIf(process.platform === 'linux')('really raises a child process', async () => {
    const { spawn } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const child = spawn('sleep', ['5']);
    try {
      // A CI runner may already start jobs above the preference; then nothing is written.
      const before = Number(readFileSync(`/proc/${child.pid}/oom_score_adj`, 'utf8'));
      expect(preferForOomKill(child.pid!)).toBe(before < AGENT_OOM_SCORE_ADJ);
      expect(Number(readFileSync(`/proc/${child.pid}/oom_score_adj`, 'utf8'))).toBe(Math.max(before, AGENT_OOM_SCORE_ADJ));
    } finally {
      child.kill();
    }
  });
});
