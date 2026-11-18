import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// Same capture stub as `private-mcp-launch.test.ts`: what the engine puts INTO the spec.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'codex' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      const sessionId = `sess-${captured.specs.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const TASK: WorkflowDef = {
  name: 'one-step',
  source: 'file',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

/** Fork, owner-approved 2026-11-18: `codexFullAccess` in the registry entry lifts Codex's sandbox. */
describe('codexFullAccess at launch', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-codex-full-access-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = config.projects.filter((p) => p.root !== repoRoot);
    });
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function grant(value: unknown): Promise<void> {
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push({ id: 'granted', root: repoRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local', codexFullAccess: value as boolean });
    });
  }

  async function specAt(index: number): Promise<AgentRunSpec> {
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.specs[index] as AgentRunSpec;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  it('a granted project runs its opening Codex session and its Continue with full access', async () => {
    await grant(true);
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'codex' });
    expect((await specAt(0)).fullAccess).toBe(true);
    await settled(record.id);
    expect(manager!.continueRun(record.id, { text: 'more', runner: 'codex' })).toEqual({ ok: true });
    expect((await specAt(1)).fullAccess).toBe(true);
    await settled(record.id);
  });

  it('an unregistered or ungranted project keeps the sandbox', async () => {
    const record = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'codex' });
    expect((await specAt(0)).fullAccess).toBeUndefined();
    await settled(record.id);
  });

  it('only an explicit true grants it, and only to Codex', async () => {
    await grant('yes');
    const codex = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'codex' });
    expect((await specAt(0)).fullAccess).toBeUndefined();
    await settled(codex.id);

    await mergeWriteWorkspaceConfig((config) => {
      for (const p of config.projects) if (p.root === repoRoot) p.codexFullAccess = true;
    });
    const claude = manager!.startRun(TASK, { task: 'do it', worktree: false, runner: 'claude' });
    expect((await specAt(1)).fullAccess).toBeUndefined();
    await settled(claude.id);
  });

  it('a read-only run keeps the sandbox even in a granted project', async () => {
    await grant(true);
    const record = manager!.startRun(TASK, { task: 'look', worktree: false, readOnly: true, runner: 'codex' });
    expect((await specAt(0)).fullAccess).toBeUndefined();
    await settled(record.id);
  });
});
