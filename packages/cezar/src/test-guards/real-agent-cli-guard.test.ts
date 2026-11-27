import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest.setup.ts: a unit test must never start a real agent CLI (2026-11-27).
describe('real agent CLI guard', () => {
  it('refuses to spawn an agent CLI by name or by an existing path', () => {
    expect(() => spawn('opencode', ['serve'])).toThrow(/real opencode CLI/);
    const dir = mkdtempSync(join(tmpdir(), 'cez-cli-guard-'));
    try {
      const claude = join(dir, 'claude');
      writeFileSync(claude, '#!/bin/sh\n', { mode: 0o755 });
      expect(() => spawn(claude, ['--print'])).toThrow(/real claude CLI/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a missing path fail as ENOENT and spawns everything else', async () => {
    const missing = spawn('/no/such/dir/claude', []);
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => missing.on('error', resolve));
    expect(error.code).toBe('ENOENT');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
  });
});
