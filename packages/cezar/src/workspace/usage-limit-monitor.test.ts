import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import { normalizeClaudeTerminalUsageLimit, normalizeClaudeUsageWindows, normalizeCodexUsageWindows } from '../core/usage-windows.ts';
import { summarizeObservation, UsageLimitMonitor, usageLimitConfig, type LimitTransition } from './usage-limit-monitor.ts';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const inMin = (minutes: number) => NOW + minutes * 60_000;

/** Claude Code's `rate_limit_event`, real wire shape (seconds). */
const claudeEvent = (utilization: number, resetsAtMs = inMin(60)) => normalizeClaudeUsageWindows({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization, resetsAt: Math.floor(resetsAtMs / 1000) },
      seven_day: { utilization: 0.2, resetsAt: Math.floor(inMin(3 * 1440) / 1000) },
    },
  },
}, NOW)!;

/** Codex `account/rateLimits/updated` params. */
const codexEvent = (usedPercent: number, resetsAtMs = inMin(45)) => normalizeCodexUsageWindows({
  rateLimits: {
    primary: { usedPercent, windowDurationMins: 300, resetsAt: Math.floor(resetsAtMs / 1000) },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: Math.floor(inMin(5 * 1440) / 1000) },
  },
}, 'codex-notification', NOW);

describe('usage-limit monitor', () => {
  let home: string;
  let path: string;
  let monitor: UsageLimitMonitor;
  let seen: LimitTransition[];
  const config = usageLimitConfig({});

  beforeEach(() => {
    // Under the setup file's sandboxed CEZ_HOME, which is what the write guard accepts.
    mkdirSync(cezarHomeDir(), { recursive: true });
    home = mkdtempSync(join(cezarHomeDir(), 'limits-'));
    path = join(home, 'usage-limits.json');
    monitor = new UsageLimitMonitor(() => path);
    seen = [];
    monitor.subscribe((t) => seen.push(t));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('reads the defaults and the CEZ_LIMIT_* overrides, keeping a default for nonsense', () => {
    expect(usageLimitConfig({})).toEqual({ lowPercent: 10, keepRunning: 2, rampMs: 120_000, fallback: true });
    expect(usageLimitConfig({ CEZ_LIMIT_LOW_PCT: '25', CEZ_LIMIT_KEEP: '1', CEZ_LIMIT_RAMP_SEC: '30', CEZ_LIMIT_FALLBACK: '0' }))
      .toEqual({ lowPercent: 25, keepRunning: 1, rampMs: 30_000, fallback: false });
    expect(usageLimitConfig({ CEZ_LIMIT_LOW_PCT: 'x', CEZ_LIMIT_KEEP: '-1', CEZ_LIMIT_RAMP_SEC: '99999' }))
      .toEqual({ lowPercent: 10, keepRunning: 2, rampMs: 120_000, fallback: true });
  });

  it('takes the tightest account-wide window from Claude and Codex fixtures', () => {
    expect(summarizeObservation(claudeEvent(0.93), NOW)).toEqual({ remainingPercent: 7, resetsAt: inMin(60), windowId: 'five_hour', exhausted: false });
    expect(summarizeObservation(codexEvent(95), NOW)).toEqual({ remainingPercent: 5, resetsAt: inMin(45), windowId: 'codex:primary', exhausted: false });
    // A model-specific bucket never speaks for the account.
    const scoped = normalizeCodexUsageWindows({ rateLimitsByLimitId: { gpt_x: { limitId: 'gpt_x', primary: { usedPercent: 99, resetsAt: Math.floor(inMin(10) / 1000) } } } }, 'codex-notification', NOW);
    expect(summarizeObservation(scoped, NOW)).toBeNull();
    const terminal = normalizeClaudeTerminalUsageLimit({ type: 'result', is_error: true, result: `Claude AI usage limit reached|${Math.floor(inMin(30) / 1000)}` }, NOW);
    expect(terminal && summarizeObservation(terminal, NOW)?.exhausted).toBe(true);
  });

  it('warns once per window at the threshold and parks until the reset', () => {
    monitor.observe('claude:default', claudeEvent(0.5), NOW, config);
    expect(seen).toEqual([]);
    expect(monitor.parkingDeadline('claude:default', NOW)).toBeNull();
    monitor.observe('claude:default', claudeEvent(0.9), NOW, config);
    expect(seen.map((t) => t.kind)).toEqual(['low']);
    expect(seen[0]!.state).toMatchObject({ account: 'claude:default', provider: 'claude', profileId: 'default', remainingPercent: 10, state: 'low' });
    // The same window again (a few seconds of reset jitter): no second warning.
    monitor.observe('claude:default', claudeEvent(0.95, inMin(60) + 5_000), NOW + 1000, config);
    expect(seen.map((t) => t.kind)).toEqual(['low']);
    expect(monitor.parkingDeadline('claude:default', NOW + 1000)).toBe(inMin(60) + 5_000);
    // Another account is its own budget.
    expect(monitor.parkingDeadline('codex:default', NOW)).toBeNull();
  });

  it('clears at the reset and warns again in the next window', () => {
    monitor.observe('codex:default', codexEvent(92), NOW, config);
    monitor.tick(inMin(46));
    expect(seen.map((t) => t.kind)).toEqual(['low', 'cleared']);
    expect(monitor.parkingDeadline('codex:default', inMin(46))).toBeNull();
    monitor.observe('codex:default', codexEvent(91, inMin(400)), inMin(50), config);
    expect(seen.map((t) => t.kind)).toEqual(['low', 'cleared', 'low']);
  });

  it('clears when a fresh observation shows the allowance is back', () => {
    monitor.observe('claude:default', claudeEvent(0.95), NOW, config);
    monitor.observe('claude:default', claudeEvent(0.1, inMin(300)), NOW + 1000, config);
    expect(seen.map((t) => t.kind)).toEqual(['low', 'cleared']);
  });

  it('marks an exhausted account from a parsed failure, warning first when nothing warned yet', () => {
    monitor.markExhausted('claude:work', inMin(20), NOW, config);
    expect(seen.map((t) => t.kind)).toEqual(['low', 'exhausted']);
    expect(monitor.get('claude:work')).toMatchObject({ state: 'exhausted', remainingPercent: 0, resetsAt: inMin(20) });
    // The existing usage-limit holds own an exhausted account; the monitor never parks it too.
    expect(monitor.parkingDeadline('claude:work', NOW)).toBeNull();
    // Without a reset the state is advisory only: it never parks work it could not release.
    monitor.markExhausted('codex:default', null, NOW, config);
    expect(monitor.parkingDeadline('codex:default', NOW)).toBeNull();
  });

  it('survives a restart through usage-limits.json and salvages valid rows', () => {
    monitor.observe('claude:default', claudeEvent(0.95), NOW, config);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { accounts: unknown[] };
    writeFileSync(path, JSON.stringify({ version: 1, accounts: [...stored.accounts, { account: 42 }] }));
    const restarted = new UsageLimitMonitor(() => path);
    const again: LimitTransition[] = [];
    restarted.subscribe((t) => again.push(t));
    expect(restarted.parkingDeadline('claude:default', NOW)).toBe(inMin(60));
    restarted.observe('claude:default', claudeEvent(0.96), NOW + 1000, config);
    expect(again).toEqual([]); // already warned for this window before the restart
    writeFileSync(path, '{not json');
    expect(new UsageLimitMonitor(() => path).list(NOW)).toEqual([]);
  });

  it('does not write on every healthy observation', () => {
    monitor.observe('claude:default', claudeEvent(0.2), NOW, config);
    rmSync(path, { force: true });
    monitor.observe('claude:default', claudeEvent(0.21), NOW + 1000, config);
    expect(() => readFileSync(path)).toThrow();
  });
});
