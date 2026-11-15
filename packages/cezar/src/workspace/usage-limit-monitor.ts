/**
 * Usage-limit monitor (spec 2026-11-15-usage-limit-fallback).
 *
 * One process-wide view of every account's remaining allowance, fed only by what the runners
 * already stream (Claude `rate_limit_event`, Codex `account/rateLimits/updated`) and by parsed
 * usage-limit failures — never a request of its own. State lives in memory and in
 * `cezarHomeDir()/usage-limits.json`, which may be deleted at any time.
 *
 * @author Skorowid
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageLimitStateSchema, type UsageLimitState, type UsageWindowsObservation } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

export interface UsageLimitConfig {
  /** Remaining percentage at or below which an account is "low". */
  lowPercent: number;
  /** How many of an account's tasks keep working while it is low. */
  keepRunning: number;
  /** Delay between two resumed tasks after a reset. */
  rampMs: number;
  /** Automatic hand-over to an agent that still has allowance. */
  fallback: boolean;
}

const intIn = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** `CEZ_LIMIT_*` with safe defaults; an invalid value keeps the default. Read on every call. */
export function usageLimitConfig(env: NodeJS.ProcessEnv = process.env): UsageLimitConfig {
  return {
    lowPercent: intIn(env.CEZ_LIMIT_LOW_PCT, 10, 0, 100),
    keepRunning: Math.floor(intIn(env.CEZ_LIMIT_KEEP, 2, 0, 100)),
    rampMs: Math.floor(intIn(env.CEZ_LIMIT_RAMP_SEC, 120, 0, 3600)) * 1000,
    fallback: env.CEZ_LIMIT_FALLBACK !== '0',
  };
}

export interface ObservedLimit { remainingPercent: number | null; resetsAt: number | null; windowId: string | null; exhausted: boolean }

/**
 * The tightest account-wide window of one observation: highest used share among windows that
 * cover every model and have not reset yet. A model-specific bucket never speaks for the account.
 */
export function summarizeObservation(observation: UsageWindowsObservation, now = Date.now()): ObservedLimit | null {
  let best: ObservedLimit | null = null;
  for (const w of observation.windows) {
    if (w.applicability !== 'all') continue;
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    const used = w.status === 'blocked' ? 100 : w.usedPercent;
    if (used === null) continue;
    const remaining = Math.max(0, Math.min(100, 100 - used));
    if (best === null || best.remainingPercent === null || remaining < best.remainingPercent) {
      best = { remainingPercent: remaining, resetsAt: w.resetsAt, windowId: w.id, exhausted: remaining <= 0 };
    }
  }
  return best;
}

export type LimitTransition =
  | { kind: 'low'; state: UsageLimitState }
  | { kind: 'exhausted'; state: UsageLimitState }
  | { kind: 'cleared'; state: UsageLimitState };

type Listener = (transition: LimitTransition) => void;

const splitKey = (account: string): { provider: string; profileId: string } => {
  const at = account.indexOf(':');
  return at === -1 ? { provider: account, profileId: 'default' } : { provider: account.slice(0, at), profileId: account.slice(at + 1) || 'default' };
};

export class UsageLimitMonitor {
  private states = new Map<string, UsageLimitState>();
  private listeners = new Set<Listener>();
  private loadedFrom: string | undefined;
  private warnedWrite = false;

  constructor(private readonly pathFor: () => string = () => join(cezarHomeDir(), 'usage-limits.json')) {}

  /** Lazy and per path: a changed `CEZ_HOME` (tests, containers) reads its own file. */
  private ensureLoaded(): void {
    const path = this.pathFor();
    if (this.loadedFrom === path) return;
    this.loadedFrom = path;
    this.states = new Map();
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const list = raw && typeof raw === 'object' && Array.isArray((raw as { accounts?: unknown }).accounts) ? (raw as { accounts: unknown[] }).accounts : [];
      // Salvage per entry: one bad row never drops the others.
      for (const entry of list.slice(0, 256)) {
        const parsed = usageLimitStateSchema.safeParse(entry);
        if (parsed.success) this.states.set(parsed.data.account, parsed.data);
      }
    } catch { /* missing or corrupt: start empty */ }
  }

  private save(): void {
    const path = this.pathFor();
    try {
      assertCezarHomeWriteIsSandboxed(path);
      atomicWriteJsonSync(path, { version: 1, accounts: [...this.states.values()] });
    } catch (error) {
      if (error instanceof Error && /sandbox/i.test(error.message)) throw error;
      if (!this.warnedWrite) console.warn('[cezar] usage-limits.json is not writable; limit state stays in memory.');
      this.warnedWrite = true;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(transition: LimitTransition): void {
    for (const listener of [...this.listeners]) {
      try { listener(transition); } catch { /* a listener never breaks the stream */ }
    }
  }

  /** Expire states whose window has reset; returns the accounts that cleared. */
  private expire(now: number): UsageLimitState[] {
    const cleared: UsageLimitState[] = [];
    for (const [key, state] of this.states) {
      if (state.state !== 'ok' && state.resetsAt !== null && state.resetsAt <= now) {
        const next: UsageLimitState = { ...state, state: 'ok', remainingPercent: null, resetsAt: null, windowId: null };
        this.states.set(key, next);
        cleared.push(next);
      }
    }
    return cleared;
  }

  /** Re-evaluate expiry now (timers call this at a reset instant). */
  tick(now = Date.now()): void {
    this.ensureLoaded();
    const cleared = this.expire(now);
    if (cleared.length) this.save();
    for (const state of cleared) this.emit({ kind: 'cleared', state });
  }

  observe(account: string, observation: UsageWindowsObservation, now = Date.now(), config = usageLimitConfig()): void {
    const summary = summarizeObservation(observation, now);
    if (!summary) return;
    this.apply(account, summary, now, config);
  }

  /** A parsed usage-limit failure: the account is exhausted until `resetsAt`. */
  markExhausted(account: string, resetsAt: number | null, now = Date.now(), config = usageLimitConfig()): void {
    this.apply(account, { remainingPercent: 0, resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null, windowId: 'terminal-limit', exhausted: true }, now, config);
  }

  private apply(account: string, summary: ObservedLimit, now: number, config: UsageLimitConfig): void {
    this.ensureLoaded();
    const cleared = this.expire(now);
    const previous = this.states.get(account);
    const { provider, profileId } = splitKey(account);
    const remaining = summary.remainingPercent;
    const level: UsageLimitState['state'] = summary.exhausted ? 'exhausted'
      : remaining !== null && remaining <= config.lowPercent ? 'low' : 'ok';
    // A low state without a known reset could never lift on its own, so it is only advisory: it
    // is recorded and warned about, never used to park work (see `parkingDeadline`).
    const next: UsageLimitState = {
      account, provider, profileId,
      remainingPercent: remaining, resetsAt: summary.resetsAt, windowId: summary.windowId,
      state: level, observedAt: now,
      warnedResetsAt: previous?.warnedResetsAt ?? null,
    };
    // Once per window: providers restate a window's reset with a few seconds of jitter.
    const warned = previous?.warnedResetsAt ?? null;
    const alreadyWarned = summary.resetsAt !== null
      ? warned !== null && Math.abs(warned - summary.resetsAt) < 120_000
      : previous !== undefined && previous.state !== 'ok';
    const transitions: LimitTransition[] = cleared.map((state) => ({ kind: 'cleared', state }));
    if (level === 'ok' && previous && previous.state !== 'ok' && !cleared.some((c) => c.account === account)) {
      transitions.push({ kind: 'cleared', state: next });
    }
    if (level !== 'ok' && !alreadyWarned) {
      if (summary.resetsAt !== null) next.warnedResetsAt = summary.resetsAt;
      transitions.push({ kind: 'low', state: next });
    }
    if (level === 'exhausted' && previous?.state !== 'exhausted') transitions.push({ kind: 'exhausted', state: next });
    const changed = JSON.stringify({ ...previous, observedAt: 0 }) !== JSON.stringify({ ...next, observedAt: 0 });
    this.states.set(account, next);
    // Writes follow transitions and threshold-relevant changes only — a chatty stream is not I/O.
    if (transitions.length || (changed && (level !== 'ok' || previous?.state !== 'ok' || !previous))) this.save();
    for (const transition of transitions) this.emit(transition);
  }

  get(account: string): UsageLimitState | undefined {
    this.ensureLoaded();
    return this.states.get(account);
  }

  list(now = Date.now()): UsageLimitState[] {
    this.tick(now);
    return [...this.states.values()].sort((a, b) => a.account.localeCompare(b.account));
  }

  /** The reset instant until which new work on `account` parks, or null when it may run. */
  parkingDeadline(account: string, now = Date.now()): number | null {
    this.ensureLoaded();
    const state = this.states.get(account);
    // Exhausted accounts are held by the auto-resume/fallback holds (spec 2026-08-03); parking them
    // too would hold the resume that reopens the window.
    if (!state || state.state !== 'low' || state.resetsAt === null || state.resetsAt <= now) return null;
    return state.resetsAt;
  }

  /** Every account currently parking work, with its reset instant. */
  parkingAccounts(now = Date.now()): Map<string, number> {
    this.ensureLoaded();
    const out = new Map<string, number>();
    for (const state of this.states.values()) {
      const until = this.parkingDeadline(state.account, now);
      if (until !== null) out.set(state.account, until);
    }
    return out;
  }

  /** Tests only: forget state (subscribed managers stay subscribed). */
  resetForTests(): void {
    this.states.clear();
    this.loadedFrom = undefined;
  }
}

/** The process-wide monitor every RunManager shares: one account can drive tasks in many projects. */
export const usageLimitMonitor = new UsageLimitMonitor();
