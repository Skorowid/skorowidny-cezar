/**
 * Size bounds for one transcript event. An adapter result can carry a multi-megabyte base64
 * image (Codex `imageGeneration` stores it twice per image), and a transcript of such events,
 * read whole, blocks the event loop and exhausts the heap.
 *
 * Two bounds, applied on write AND on read (old files still hold the payloads):
 *  - base64 images embedded anywhere in an event are cut out — on write saved as a file next to
 *    the run, on read replaced by a placeholder;
 *  - no event is larger than {@link MAX_EVENT_BYTES}; longer strings are truncated with a marker.
 *
 * @author Skorowid
 */

/** Hard cap on one serialized event (a persisted NDJSON line, a live SSE frame, a history read). */
export const MAX_EVENT_BYTES = 256 * 1024;

/** A run's transcript is announced as oversized at every multiple of this size. */
export const TRANSCRIPT_WARN_BYTES = 100 * 1024 * 1024;

/** Base64 shorter than this is left alone — an icon in a tool result is not the problem. */
const MIN_INLINE_IMAGE_CHARS = 4096;

/** Kept from a truncated string, so the reader still sees what it was. */
const TRUNCATED_KEEP_CHARS = 2048;

const MAX_DEPTH = 64;

// PNG, JPEG, GIF and RIFF magic as base64. Base64 needs no JSON escaping, so the same scan also
// finds an image inside a JSON-stringified tool result. A hand scan, not a regex: V8's backtracking
// stack overflows on a greedy class over megabytes.
const IMAGE_MAGICS = ['iVBORw0KGgo', '/9j/', 'R0lGOD', 'UklGR'];
// One-character search: native speed, and nothing for the backtracking stack to grow on.
const NON_BASE64_RE = /[^A-Za-z0-9+/]/g;
const DATA_URI_RE = /data:image\/[a-z+.-]+;base64,$/;

function isBase64Char(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
}

/** True when `text[start, end)` is unbroken base64 — the native decoder drops what is not. */
function isBase64Span(text: string, start: number, end: number): boolean {
  const length = end - start;
  if (length % 4 === 1) return false;
  return Buffer.from(text.slice(start, end), 'base64').length === Math.floor((length * 3) / 4);
}

/** Where the base64 run starting at `at` ends (padding excluded). Inside JSON text it ends at a
 *  quote or an escape, so that guess is tried first and checked by decoding — a per-character
 *  scan over megabytes was half of a legacy read's time. */
function base64RunEnd(text: string, at: number): number {
  let stop = text.length;
  for (const delimiter of ['"', '\\']) {
    const i = text.indexOf(delimiter, at);
    if (i !== -1 && i < stop) stop = i;
  }
  let end = stop;
  while (end > at && stop - end < 2 && text.charCodeAt(end - 1) === 61) end -= 1;
  if (isBase64Span(text, at, end)) return end;
  NON_BASE64_RE.lastIndex = at;
  return NON_BASE64_RE.exec(text)?.index ?? text.length;
}

/** Spans `[start, end)` of base64 image runs, `start` widened over a `data:` URI prefix. */
function findImageRuns(text: string): Array<{ start: number; dataStart: number; end: number }> {
  const runs: Array<{ start: number; dataStart: number; end: number }> = [];
  let from = 0;
  // Next hit per magic, refreshed only once passed — one pass over the text per magic in total.
  const next = IMAGE_MAGICS.map((magic) => text.indexOf(magic));
  while (from < text.length) {
    let at = -1;
    IMAGE_MAGICS.forEach((magic, k) => {
      if (next[k]! !== -1 && next[k]! < from) next[k] = text.indexOf(magic, from);
      const i = next[k]!;
      if (i !== -1 && (at === -1 || i < at)) at = i;
    });
    if (at === -1) break;
    const end = base64RunEnd(text, at);
    let padded = end;
    while (padded < text.length && padded - end < 2 && text.charCodeAt(padded) === 61) padded += 1;
    // A magic found mid-run belongs to that run: only a run that STARTS with it counts.
    const startsRun = at === 0 || !isBase64Char(text.charCodeAt(at - 1));
    if (startsRun && end - at >= MIN_INLINE_IMAGE_CHARS) {
      const prefix = DATA_URI_RE.exec(text.slice(Math.max(0, at - 48), at));
      runs.push({ start: prefix ? at - prefix[0].length : at, dataStart: at, end: padded });
    }
    from = Math.max(end, at + 1);
  }
  return runs;
}

export interface InlineImage {
  mediaType: string;
  /** Plain base64, no `data:` prefix. */
  data: string;
}

/** Returns where the image now lives (a served URL), or undefined when it was not kept. */
export type InlineImageSaver = (image: InlineImage) => string | undefined;

export interface EventTruncation {
  originalBytes: number;
}

function sniffMediaType(base64: string): string | undefined {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function replaceImagesInString(text: string, save: InlineImageSaver): string {
  if (text.length < MIN_INLINE_IMAGE_CHARS) return text;
  const runs = findImageRuns(text);
  if (runs.length === 0) return text;
  let out = '';
  let last = 0;
  for (const run of runs) {
    const data = text.slice(run.dataStart, run.end);
    const mediaType = sniffMediaType(data);
    if (!mediaType) continue;
    const kb = Math.round((data.length * 3) / 4 / 1024);
    const url = save({ mediaType, data });
    // No quote or backslash, so the replacement keeps a JSON-stringified host string valid.
    out += text.slice(last, run.start) + (url ? `[image ${mediaType} ${kb} KB saved as ${url}]` : `[image ${mediaType} ${kb} KB omitted]`);
    last = run.end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Deep map over every string leaf; returns the SAME reference when nothing changed. */
function mapStrings(value: unknown, fn: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((item, index) => {
      const next = mapStrings(item, fn, depth + 1);
      if (next !== item) (out ??= [...value])[index] = next;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = mapStrings(item, fn, depth + 1);
    if (next !== item) (out ??= { ...(value as Record<string, unknown>) })[key] = next;
  }
  return out ?? value;
}

/**
 * Replace every base64 image embedded in `value` (as a whole string or inside one) with a short
 * reference. `save` decides where the bytes go; without one they are dropped.
 */
export function externalizeInlineImages<T>(value: T, save: InlineImageSaver = () => undefined): T {
  return mapStrings(value, (text) => replaceImagesInString(text, save)) as T;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateString(text: string, keep: number): string {
  if (text.length <= keep) return text;
  return `${text.slice(0, keep)}… [truncated ${text.length - keep} chars]`;
}

/** Strings worth shortening, longest first. */
function longStrings(value: unknown, found: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') {
    if (value.length > TRUNCATED_KEEP_CHARS) found.push(value);
  } else if (depth < MAX_DEPTH && value !== null && typeof value === 'object') {
    for (const item of Array.isArray(value) ? value : Object.values(value)) longStrings(item, found, depth + 1);
  }
  return found;
}

/** The identity a reader needs to place an event that had to be replaced wholesale. */
function skeleton(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['type', 'stepId', 'itemId', 'toolCallId', 'id', 'tool', 'isError', 'message', 'seq', 'ts']) {
    const v = event[key];
    if (typeof v === 'string') out[key] = truncateString(v, 512);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  const item = event.item;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const kept: Record<string, unknown> = {};
    for (const key of ['kind', 'id', 'name', 'toolKind', 'title', 'status']) {
      const v = (item as Record<string, unknown>)[key];
      if (typeof v === 'string') kept[key] = truncateString(v, 512);
    }
    out.item = kept;
  }
  return out;
}

/**
 * Shrink an event to at most `maxBytes` serialized: the longest strings are truncated first, and an
 * event that is big for another reason (thousands of small entries) keeps only its identity. A
 * shrunk event carries `truncated: { originalBytes }`.
 */
export function capEventSize<T extends Record<string, unknown>>(event: T, maxBytes = MAX_EVENT_BYTES, knownBytes?: number): T {
  const originalBytes = knownBytes ?? jsonBytes(event);
  if (originalBytes <= maxBytes) return event;
  const marker = { originalBytes } satisfies EventTruncation;
  let current: Record<string, unknown> = event;
  for (let pass = 0; pass < 3; pass += 1) {
    const size = jsonBytes(current);
    if (size + 64 <= maxBytes) break;
    const strings = longStrings(current).sort((a, b) => b.length - a.length);
    if (strings.length === 0) break;
    let excess = size + 512 - maxBytes;
    const cut = new Map<string, string>();
    for (const text of strings) {
      if (excess <= 0) break;
      const keep = Math.max(TRUNCATED_KEEP_CHARS, text.length - excess);
      const next = truncateString(text, keep);
      cut.set(text, next);
      excess -= text.length - next.length;
    }
    current = mapStrings(current, (text) => cut.get(text) ?? text) as Record<string, unknown>;
  }
  const capped = withMarker(current, marker);
  if (jsonBytes(capped) <= maxBytes) return capped as T;
  return withMarker(skeleton(event), marker) as unknown as T;
}

/** The store writes `seq`/`ts` last and reads a line's seq from its tail, so they stay last. */
function withMarker(event: Record<string, unknown>, marker: EventTruncation): Record<string, unknown> {
  const { seq, ts, ...rest } = event;
  return {
    ...rest,
    truncated: marker,
    ...(seq !== undefined ? { seq } : {}),
    ...(ts !== undefined ? { ts } : {}),
  };
}

/**
 * Parse one NDJSON line, bounded: a line at or under the cap is returned as parsed, a longer one
 * (a transcript written before these bounds) loses its inline images and is capped. Unparseable
 * lines yield null.
 */
export function parseBoundedLine(line: string): Record<string, unknown> | null {
  // Chars ≤ bytes, so a short line is under the byte cap without measuring it.
  const oversized = line.length * 3 > MAX_EVENT_BYTES && Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES;
  // Cut images out of the raw text first: parsing and re-measuring megabytes of base64 is what
  // made a legacy line expensive, and the placeholder holds no character JSON would escape.
  const text = oversized ? replaceImagesInString(line, () => undefined) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const event = parsed as Record<string, unknown>;
  return oversized ? capEventSize(event) : event;
}

/**
 * Split a byte stream into lines without re-copying a long line once per chunk: the pieces of an
 * unfinished line are kept as-is and joined once, when its newline arrives. Chunks must not be
 * reused by the caller after `push`.
 */
export class LineSplitter {
  private pieces: Buffer[] = [];

  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      const line = this.pieces.length ? Buffer.concat([...this.pieces, piece]) : piece;
      this.pieces = [];
      if (line.length) lines.push(line);
      start = nl + 1;
    }
    if (start < chunk.length) this.pieces.push(chunk.subarray(start));
    return lines;
  }

  /** The trailing line without a newline, if any. */
  end(): Buffer | undefined {
    const rest = this.pieces.length ? Buffer.concat(this.pieces) : undefined;
    this.pieces = [];
    return rest?.length ? rest : undefined;
  }
}
