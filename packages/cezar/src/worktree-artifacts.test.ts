import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildArtifactCleanupEnabled, cleanBuildArtifacts, findCacheDirs } from './worktree-artifacts.ts';

const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-artifacts-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'target/\nlogs/\n');
  const dir = (path: string, tag?: string) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, 'big.bin'), 'x'.repeat(1024));
    if (tag) writeFileSync(join(root, path, 'CACHEDIR.TAG'), tag);
  };
  dir('target/debug', undefined);
  writeFileSync(join(root, 'target', 'CACHEDIR.TAG'), TAG);
  dir('crates/engine/target', TAG); // nested crate build dir
  dir('logs', undefined); // ignored, but not declared a cache
  dir('vendored-cache', TAG); // a cache tag, but tracked content: not ignored
  dir('src', undefined);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('build artifact cleanup', () => {
  it('finds directories carrying a valid CACHEDIR.TAG', async () => {
    const found = (await findCacheDirs(root)).map((p) => p.slice(root.length + 1)).sort();
    expect(found).toEqual(['crates/engine/target', 'target', 'vendored-cache']);
  });

  it('removes only git-ignored cache directories and nothing else', async () => {
    const removed = (await cleanBuildArtifacts(root)).sort();
    expect(removed).toEqual(['crates/engine/target', 'target']);
    expect(existsSync(join(root, 'target'))).toBe(false);
    expect(existsSync(join(root, 'crates/engine/target'))).toBe(false);
    expect(existsSync(join(root, 'logs/big.bin'))).toBe(true);
    expect(existsSync(join(root, 'vendored-cache/big.bin'))).toBe(true);
    expect(existsSync(join(root, 'src/big.bin'))).toBe(true);
  });

  it('a tag with the wrong signature is not a cache', async () => {
    writeFileSync(join(root, 'target', 'CACHEDIR.TAG'), 'not a signature\n');
    expect((await cleanBuildArtifacts(root))).toEqual(['crates/engine/target']);
    expect(existsSync(join(root, 'target/debug/big.bin'))).toBe(true);
  });

  it('is on by default and off with CEZ_CLEAN_BUILD_ARTIFACTS=0', () => {
    expect(buildArtifactCleanupEnabled({})).toBe(true);
    expect(buildArtifactCleanupEnabled({ CEZ_CLEAN_BUILD_ARTIFACTS: '0' })).toBe(false);
  });
});
