import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capEventSize, externalizeInlineImages, MAX_EVENT_BYTES, parseBoundedLine, TRANSCRIPT_WARN_BYTES } from './event-bounds.ts';
import { readRunHistoryPage } from './event-history.ts';
import { RunStore, type RunEvent } from './store.ts';

// Codex imageGeneration writes a multi-megabyte base64 PNG twice per image into the transcript;
// whole-file reads of such a transcript froze the cockpit.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_RUN = /[A-Za-z0-9+/]{4000,}/;

function fakePng(bytes: number, fill = 7): Buffer {
  const body = Buffer.alloc(bytes, 0);
  for (let i = 0; i < bytes; i += 1) body[i] = (i * 31 + fill) & 0xff;
  return Buffer.concat([PNG_MAGIC, body]);
}

/** The two events Codex's imageGeneration produced, as the runner and sink emitted them. */
function imageGenerationEvents(base64: string): Array<{ type: string; [key: string]: unknown }> {
  const item = { type: 'imageGeneration', id: 'exec-1', status: 'completed', revisedPrompt: 'a robot', result: base64, savedPath: '/x.png' };
  return [
    { type: 'item.completed', stepId: 's1', item: { kind: 'tool', id: 'exec-1', name: 'imageGeneration', toolKind: 'other', title: 'imageGeneration', status: 'completed', input: item } },
    { type: 'tool-result', stepId: 's1', toolCallId: 'exec-1', result: JSON.stringify(item), isError: false },
  ];
}

let dataDir: string;
let store: RunStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-transcript-bounds-'));
  store = RunStore.open(dataDir);
});

afterEach(() => {
  store.flush();
  rmSync(dataDir, { recursive: true, force: true });
});

const ndjson = (runId: string): string => join(dataDir, 'runs', `${runId}.ndjson`);

describe('event-bounds', () => {
  it('replaces a base64 PNG, bare or inside a JSON string, and keeps the host JSON valid', () => {
    const base64 = fakePng(64 * 1024).toString('base64');
    const saved: string[] = [];
    const [completed, result] = imageGenerationEvents(base64).map((e) =>
      externalizeInlineImages(e, (image) => {
        saved.push(image.mediaType);
        expect(image.data).toBe(base64);
        return '/api/v1/runs/r/images/generated-x.png';
      }),
    );
    expect(saved).toEqual(['image/png', 'image/png']);
    expect(JSON.stringify(completed)).not.toMatch(BASE64_RUN);
    expect((completed!.item as { input: { result: string } }).input.result).toMatch(/^\[image image\/png 64 KB saved as /);
    expect(JSON.parse(result!.result as string).result).toMatch(/saved as \/api\/v1\/runs\/r\/images\/generated-x\.png/);
  });

  it('leaves non-image base64 and short strings untouched (same reference)', () => {
    const event = { type: 'tool-result', result: Buffer.alloc(20_000, 1).toString('base64'), text: 'short' };
    expect(externalizeInlineImages(event)).toBe(event);
  });

  it('caps an oversized event, marks it and keeps seq/ts last', () => {
    const event = { type: 'tool-result', toolCallId: 't', result: 'x'.repeat(2_000_000), seq: 9, ts: 'now' };
    const capped = capEventSize(event);
    const line = JSON.stringify(capped);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect((capped as Record<string, unknown>).truncated).toEqual({ originalBytes: Buffer.byteLength(JSON.stringify(event)) });
    expect(capped.result).toMatch(/^x+… \[truncated \d+ chars\]$/);
    expect(line).toMatch(/"seq":9,"ts":"now"\}$/);
  });

  it('falls back to the event identity when no single string is to blame', () => {
    const event = { type: 'item.completed', stepId: 's', item: { kind: 'tool', id: 'i', entries: Array.from({ length: 50_000 }, (_, n) => n) }, seq: 1, ts: 't' };
    const capped = capEventSize(event) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(capped).toMatchObject({ type: 'item.completed', stepId: 's', item: { kind: 'tool', id: 'i' }, seq: 1, ts: 't' });
  });

  it('parses a legacy multi-megabyte line into a bounded event without its image', () => {
    const [completed] = imageGenerationEvents(fakePng(4 * 1024 * 1024).toString('base64'));
    const parsed = parseBoundedLine(JSON.stringify({ ...completed, seq: 3, ts: 't' }))!;
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(JSON.stringify(parsed)).not.toMatch(BASE64_RUN);
    expect((parsed.item as { input: { result: string } }).input.result).toMatch(/KB omitted\]$/);
  });
});

describe('RunStore write path', () => {
  it('saves a generated image once as a file and persists only references', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const png = fakePng(3 * 1024 * 1024);
    const live: RunEvent[] = [];
    store.on('event', ({ event }: { event: RunEvent }) => live.push(event));
    for (const event of imageGenerationEvents(png.toString('base64'))) store.appendEvent(run.id, event);

    const raw = readFileSync(ndjson(run.id), 'utf8');
    expect(raw).not.toMatch(BASE64_RUN);
    for (const line of raw.trim().split('\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(JSON.stringify(live)).not.toMatch(BASE64_RUN);

    const files = readdirSync(join(dataDir, 'runs', `${run.id}-images`));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^generated-[0-9a-f]+\.png$/);
    expect(readFileSync(join(dataDir, 'runs', `${run.id}-images`, files[0]!)).equals(png)).toBe(true);

    const images = store.readEventsSync(run.id).filter((e) => e.type === 'image');
    expect(images).toEqual([
      expect.objectContaining({ stepId: 's1', name: files[0], url: `/api/v1/runs/${run.id}/images/${files[0]}` }),
    ]);
  });

  it('truncates an oversized non-image event on disk and on the live wire', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const live: RunEvent[] = [];
    store.on('event', ({ event }: { event: RunEvent }) => live.push(event));
    const persisted = store.appendEvent(run.id, { type: 'tool-result', toolCallId: 'c', result: 'y'.repeat(1_500_000) });
    expect(persisted.truncated).toEqual({ originalBytes: expect.any(Number) });
    expect(Buffer.byteLength(JSON.stringify(live.at(-1)))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(Buffer.byteLength(readFileSync(ndjson(run.id)))).toBeLessThanOrEqual(MAX_EVENT_BYTES + 1);
  });

  it('caps ephemeral live frames too, without saving files', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    const [completed] = imageGenerationEvents(fakePng(1024 * 1024).toString('base64'));
    const frame = store.emitEphemeral(run.id, { ...completed!, type: 'item.updated' });
    expect(JSON.stringify(frame)).not.toMatch(BASE64_RUN);
    expect(existsSync(join(dataDir, 'runs', `${run.id}-images`))).toBe(false);
  });

  it('adds a danger note when the transcript crosses the size threshold, once per crossing', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(ndjson(run.id), '');
    truncateSync(ndjson(run.id), TRANSCRIPT_WARN_BYTES - 10); // sparse: no real disk cost
    const live: RunEvent[] = [];
    store.on('event', ({ event }: { event: RunEvent }) => live.push(event));
    store.appendEvent(run.id, { type: 'note', stepId: 's', message: 'crosses' });
    store.appendEvent(run.id, { type: 'note', stepId: 's', message: 'stays over' });
    const warnings = live.filter((e) => e.transcriptWarning === true);
    expect(warnings).toEqual([
      expect.objectContaining({ type: 'note', tone: 'danger', stepId: 's', message: expect.stringMatching(/100 MB/) }),
    ]);
  });
});

describe('RunStore read path on a legacy oversized transcript', { timeout: 30_000 }, () => {
  function writeLegacy(runId: string): void {
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const base64 = fakePng(5 * 1024 * 1024).toString('base64');
    const lines: unknown[] = [{ type: 'user-message', text: 'first ask', seq: 1, ts: 't' }];
    let seq = 2;
    for (let n = 0; n < 4; n += 1) {
      for (const event of imageGenerationEvents(base64)) lines.push({ ...event, seq: seq++, ts: 't' });
    }
    lines.push({ type: 'user-message', text: 'latest ask', seq: seq++, ts: 't' });
    lines.push({ type: 'text', text: 'done', seq: seq++, ts: 't' });
    appendFileSync(ndjson(runId), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('streams bounded events without blocking the event loop', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    writeLegacy(run.id);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    const events = await store.readEvents(run.id);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(events).toHaveLength(11);
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(JSON.stringify(events)).not.toMatch(BASE64_RUN);
    expect(store.readEventsSync(run.id)).toEqual(events);
  });

  it('finds the latest user message from the end of the file', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    writeLegacy(run.id);
    const latest = await store.findLastEvent(run.id, (e) => e.type === 'user-message');
    expect(latest).toMatchObject({ text: 'latest ask', seq: 10 });
    expect(await store.findLastEvent(run.id, (e) => e.type === 'tool-result')).toMatchObject({ seq: 9 });
    expect(await store.findLastEvent(run.id, (e) => e.type === 'nope')).toBeUndefined();
    expect(await store.findLastEvent('missing', () => true)).toBeUndefined();
  });

  it('rehydrates seq from a legacy file without a persisted lastSeq', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    writeLegacy(run.id);
    store.flush();
    const reopened = RunStore.open(dataDir, { keepLive: true });
    expect(reopened.getRun(run.id)?.lastSeq).toBeUndefined();
    expect(reopened.appendEvent(run.id, { type: 'note', message: 'after' }).seq).toBe(12);
  });

  it('serves bounded history pages to the cockpit', async () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [] });
    writeLegacy(run.id);
    const page = await readRunHistoryPage(ndjson(run.id));
    expect(page.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(page)).not.toMatch(BASE64_RUN);
  });
});
