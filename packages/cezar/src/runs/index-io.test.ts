import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from './store.ts';

// runs.json is rewritten whole on every save; a shared system prompt repeated in every record
// made it megabytes, and saves ran about once a second while tasks worked.

const PROMPT = `## Global instructions\n${'Follow the project rules. '.repeat(200)}`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-index-io-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

const withPrompt = (store: RunStore, title: string, systemPrompt: string) => {
  const run = store.createRun({ title, workflow: 'w', task: 't', steps: [] });
  store.updateRun(run.id, { systemPrompt });
  return run;
};

const index = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8'));

describe('runs.json stores a long system prompt once', () => {
  it('writes a reference instead of the text, one file per distinct prompt, and reads it back', () => {
    const store = RunStore.open(dataDir);
    const a = withPrompt(store, 'a', PROMPT);
    const b = withPrompt(store, 'b', PROMPT);
    const short = withPrompt(store, 'c', 'short');
    store.flush();

    const raw = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    expect(raw).not.toContain('Follow the project rules.');
    const rows = index();
    const ref = rows.find((r) => r.id === a.id)?.systemPromptRef;
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(rows.find((r) => r.id === b.id)?.systemPromptRef).toBe(ref);
    expect(rows.find((r) => r.id === short.id)).toMatchObject({ systemPrompt: 'short' });
    expect(readdirSync(join(dataDir, 'runs', 'prompts'))).toEqual([`${ref}.md`]);

    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(a.id)?.systemPrompt).toBe(PROMPT);
    expect(reopened.getRun(b.id)?.systemPrompt).toBe(PROMPT);
    expect((reopened.getRun(a.id) as Record<string, unknown>).systemPromptRef).toBeUndefined();
  });

  it('keeps the record when its prompt file is gone, without the prompt', () => {
    const store = RunStore.open(dataDir);
    const run = withPrompt(store, 'a', PROMPT);
    store.flush();
    rmSync(join(dataDir, 'runs', 'prompts'), { recursive: true, force: true });
    const reopened = RunStore.open(dataDir);
    expect(reopened.getRun(run.id)).toBeDefined();
    expect(reopened.getRun(run.id)?.systemPrompt).toBeUndefined();
  });
});

describe('the debounced save', () => {
  it('skips the rewrite when nothing persisted changed', () => {
    vi.useFakeTimers();
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    store.flush();
    const before = statSync(join(dataDir, 'runs.json')).mtimeMs;

    // A touch that changes nothing persisted (re-marking an already-unread run).
    store.setUnread(run.id);
    vi.advanceTimersByTime(10_000);
    expect(statSync(join(dataDir, 'runs.json')).mtimeMs).toBe(before);

    store.updateRun(run.id, { title: 'renamed' });
    vi.advanceTimersByTime(10_000);
    expect(index().find((r) => r.id === run.id)?.title).toBe('renamed');
  });

  it('still writes a deletion', () => {
    vi.useFakeTimers();
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    store.flush();
    store.deleteRun(run.id);
    vi.advanceTimersByTime(10_000);
    expect(index().some((r) => r.id === run.id)).toBe(false);
  });
});
