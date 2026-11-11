/**
 * OC-1: OpenCode 2.x replaced the 1.x bus events with
 * `session.*` facts under `{ type, data }`. This folds them into the 1.x shapes the runner and the
 * UI mapper already read, so there is one event pipeline. Shapes were read from a live 2.2.5 server
 * (`GET /openapi.json` and its event stream), not from documentation.
 *
 * Only this session's events pass. Child sessions are not rendered; their permission prompts and
 * forms are still surfaced by the runner, because an unanswered one blocks the parent.
 *
 * @author Skorowid
 */

export interface OpencodeLegacyEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpencodeV2Translation {
  /** 1.x shaped events, in order. */
  events: OpencodeLegacyEvent[];
  /** The turn's failure as OpenCode worded it, reported once. */
  failure?: string;
}

interface TextBuffer {
  messageID: string;
  text: string;
}

/** Per-session folding state: 2.x sends deltas and separate tool facts, 1.x parts carry the whole. */
export class OpencodeV2Translator {
  private readonly announced = new Set<string>();
  private readonly texts = new Map<string, TextBuffer>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();

  constructor(private readonly sessionId: string) {}

  translate(evt: unknown): OpencodeV2Translation {
    if (!isRecord(evt) || typeof evt.type !== 'string') return { events: [] };
    const data = isRecord(evt.data) ? evt.data : {};
    if (data.sessionID !== this.sessionId) return { events: [] };
    switch (evt.type) {
      case 'session.text.delta':
        return { events: this.textDelta(data, 'text') };
      case 'session.text.ended':
        return { events: this.textEnded(data, 'text') };
      case 'session.reasoning.delta':
        return { events: this.textDelta(data, 'reasoning') };
      case 'session.reasoning.ended':
        return { events: this.textEnded(data, 'reasoning') };
      case 'session.tool.input.started':
        if (typeof data.id === 'string' && typeof data.name === 'string') this.toolNames.set(data.id, data.name);
        return { events: [] };
      case 'session.tool.called':
        if (typeof data.id === 'string') this.toolInputs.set(data.id, data.input);
        return { events: this.tool(data, { status: 'running', input: data.input }) };
      case 'session.tool.success':
        return { events: this.tool(data, {
          status: 'completed',
          input: this.toolInputs.get(String(data.id)),
          output: contentText(data.content),
          ...(isRecord(data.metadata) ? { metadata: data.metadata } : {}),
        }) };
      case 'session.tool.failed': {
        const error = errorMessage(data.error) ?? 'the tool failed';
        return { events: this.tool(data, { status: 'error', input: this.toolInputs.get(String(data.id)), error, output: contentText(data.content) || error }) };
      }
      case 'session.usage.updated':
        // Whole-session totals, so one synthetic message keeps "cumulative per message" true.
        return { events: [{ type: 'message.updated', properties: { info: {
          id: `session-usage:${this.sessionId}`, role: 'assistant', sessionID: this.sessionId, tokens: data.tokens, cost: data.cost,
        } } }] };
      case 'session.retry.scheduled': {
        const next = typeof data.at === 'number' ? data.at : Date.parse(String(data.at));
        return { events: [{ type: 'session.status', properties: { sessionID: this.sessionId, status: {
          type: 'retry', ...(Number.isFinite(next) ? { next } : {}), message: errorMessage(data.error) ?? 'the provider refused the request',
        } } }] };
      }
      case 'session.execution.succeeded':
        return { events: [this.idle()] };
      case 'session.execution.interrupted':
        // A superseded execution hands over to the one that replaced it; the turn is still running.
        return data.reason === 'superseded' ? { events: [] } : { events: [this.idle()] };
      case 'session.execution.failed': {
        const failure = errorMessage(data.error) ?? 'the session failed';
        return { failure, events: [{ type: 'session.error', properties: { sessionID: this.sessionId, error: failure } }, this.idle()] };
      }
      default:
        return { events: [] };
    }
  }

  private idle(): OpencodeLegacyEvent {
    return { type: 'session.idle', properties: { sessionID: this.sessionId } };
  }

  /** A part is only surfaced after its message's role is known, as on the 1.x bus. */
  private announce(messageID: string): OpencodeLegacyEvent[] {
    if (this.announced.has(messageID)) return [];
    this.announced.add(messageID);
    return [{ type: 'message.updated', properties: { info: { id: messageID, role: 'assistant', sessionID: this.sessionId } } }];
  }

  private textDelta(data: Record<string, unknown>, kind: 'text' | 'reasoning'): OpencodeLegacyEvent[] {
    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    if (!messageID || typeof data.delta !== 'string') return [];
    const id = partId(messageID, kind, data.ordinal);
    const buffer = this.texts.get(id) ?? { messageID, text: '' };
    buffer.text += data.delta;
    this.texts.set(id, buffer);
    return [...this.announce(messageID), part(id, messageID, this.sessionId, kind, buffer.text)];
  }

  private textEnded(data: Record<string, unknown>, kind: 'text' | 'reasoning'): OpencodeLegacyEvent[] {
    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    if (!messageID) return [];
    const id = partId(messageID, kind, data.ordinal);
    const text = typeof data.text === 'string' ? data.text : this.texts.get(id)?.text ?? '';
    this.texts.delete(id);
    return [...this.announce(messageID), part(id, messageID, this.sessionId, kind, text, { time: { end: Date.now() } })];
  }

  private tool(data: Record<string, unknown>, state: Record<string, unknown>): OpencodeLegacyEvent[] {
    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    if (!messageID || typeof data.id !== 'string') return [];
    return [...this.announce(messageID), {
      type: 'message.part.updated',
      properties: { part: { id: data.id, messageID, sessionID: this.sessionId, type: 'tool', tool: this.toolNames.get(data.id) ?? 'tool', state } },
    }];
  }
}

/** The session a 2.x `form.created` belongs to; forms nest under `data.form`. */
export function opencodeV2FormOf(evt: unknown): Record<string, unknown> | undefined {
  if (!isRecord(evt) || evt.type !== 'form.created' || !isRecord(evt.data)) return undefined;
  return isRecord(evt.data.form) ? evt.data.form : undefined;
}

/** A 2.x `permission.asked`, in the 1.x shape `opencodePermissionReply` judges. One entry per
 *  resource: a request is granted only when every path it names is. */
export function opencodeV2PermissionOf(evt: unknown): { id: string; sessionID: string; checks: Record<string, unknown>[] } | undefined {
  if (!isRecord(evt) || evt.type !== 'permission.asked' || !isRecord(evt.data)) return undefined;
  const { id, sessionID, action, resources } = evt.data;
  if (typeof id !== 'string' || typeof sessionID !== 'string') return undefined;
  const paths = Array.isArray(resources) ? resources.filter((r): r is string => typeof r === 'string') : [];
  const permission = typeof action === 'string' ? action : 'unknown';
  return {
    id,
    sessionID,
    checks: paths.length > 0 ? paths.map(filepath => ({ permission, metadata: { filepath } })) : [{ permission, metadata: {} }],
  };
}

function partId(messageID: string, kind: string, ordinal: unknown): string {
  return `${messageID}:${kind}:${typeof ordinal === 'number' ? ordinal : 0}`;
}

function part(id: string, messageID: string, sessionID: string, type: string, text: string, extra: Record<string, unknown> = {}): OpencodeLegacyEvent {
  return { type: 'message.part.updated', properties: { part: { id, messageID, sessionID, type, text, ...extra } } };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** `Session.StructuredError`: `{ type, message, status?, … }`. */
export function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
