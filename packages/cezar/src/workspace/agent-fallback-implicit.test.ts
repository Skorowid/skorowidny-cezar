import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cezarHomeDir } from '../paths.ts';
import {
  effectiveAgentFallbackPolicySync, fallbackConsentCurrent, implicitFallbackPolicy, isImplicitFallbackPolicy, putAgentFallbackPolicy,
} from './agent-fallback.ts';
import type { AgentAccountStore } from './agent-accounts.ts';

/** Owner-approved default (spec 2026-11-15-usage-limit-fallback): fallback without a saved list. */
describe('implicit agent fallback policy', () => {
  let root: string;
  beforeEach(() => {
    mkdirSync(cezarHomeDir(), { recursive: true });
    rmSync(join(cezarHomeDir(), 'agent-fallback.json'), { force: true });
    root = mkdtempSync(join(tmpdir(), 'cez-implicit-'));
  });
  afterEach(() => {
    rmSync(join(cezarHomeDir(), 'agent-fallback.json'), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('applies to a project that never saved a list, and CEZ_LIMIT_FALLBACK=0 turns it off', () => {
    const policy = effectiveAgentFallbackPolicySync(root, {});
    expect(isImplicitFallbackPolicy(policy)).toBe(true);
    expect(policy.enabled).toBe(true);
    expect(policy.candidates).toEqual([{ provider: 'claude', profileId: 'default' }, { provider: 'codex', profileId: 'default' }]);
    expect(effectiveAgentFallbackPolicySync(root, { CEZ_LIMIT_FALLBACK: '0' }).enabled).toBe(false);
  });

  it('adds named Claude and Codex accounts after the default logins, never other providers', () => {
    const accounts = { accounts: [
      { id: 'work', provider: 'codex', configDir: '/x', addedAt: '2026-11-15T00:00:00Z' },
      { id: 'second', provider: 'claude', configDir: '/y', addedAt: '2026-11-15T00:00:00Z' },
      { id: 'o', provider: 'opencode', configDir: '/z', addedAt: '2026-11-15T00:00:00Z' },
    ] } as unknown as AgentAccountStore;
    expect(implicitFallbackPolicy(accounts).candidates.map((c) => `${c.provider}:${c.profileId}`))
      .toEqual(['claude:default', 'codex:default', 'codex:work', 'claude:second']);
  });

  it('yields to any saved policy, including one the user switched off', async () => {
    const snapshot = effectiveAgentFallbackPolicySync(root, {});
    const off = await putAgentFallbackPolicy(root, { expectedRevision: 0, expectedIncarnation: null, enabled: false, candidates: [] });
    expect('conflict' in off).toBe(false);
    const live = effectiveAgentFallbackPolicySync(root, {});
    expect(live.enabled).toBe(false);
    // A task that captured the implicit default loses that consent with the user's explicit answer.
    expect(fallbackConsentCurrent(snapshot, live)).toBe(false);
    expect(fallbackConsentCurrent(snapshot, implicitFallbackPolicy())).toBe(true);
  });
});
