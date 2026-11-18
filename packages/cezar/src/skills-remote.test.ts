import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bareDirFor, excludeFromGit, isPinnedSha, shouldPassiveFetch } from './skills-remote.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches on the first passive touch this process', () => {
    // A clone left by an earlier run must be refreshed on first read, else a
    // long-running server serves whatever ref that old clone happened to have.
    expect(shouldPassiveFetch({ attempted: false, fetchedAt: 0, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once touched', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the last fetch is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('open-mercato/skills');
    expect(bareDirFor('https://github.com/open-mercato/skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:open-mercato/skills')).toBe(expected);
    expect(expected.endsWith('open-mercato__skills')).toBe(true);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});

// git < 2.31 has no `--path-format` and echoed it back, so the exclude landed under the
// process cwd (`--path-format=absolute\n.git/info/exclude`) instead of the repository.
describe('excludeFromGit', () => {
  it('writes the repository\'s own exclude file, from the main checkout and a linked worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-exclude-'));
    try {
      const repo = join(dir, 'repo');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base');
      git(repo, 'worktree', 'add', '-q', join(dir, 'wt'));

      await excludeFromGit(repo, '.claude/skills/one/');
      await excludeFromGit(join(dir, 'wt'), '.claude/skills/two/');

      const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n');
      expect(exclude).toContain('.claude/skills/one/');
      expect(exclude).toContain('.claude/skills/two/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
