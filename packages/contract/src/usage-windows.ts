import { z } from 'zod';

/** Metadata only: no raw provider messages, credentials or prompts. Times are epoch ms. */
export const usageWindowSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(['five-hour', 'weekly', 'primary', 'secondary', 'other']),
  limitId: z.string().max(128).optional(),
  applicability: z.enum(['all', 'models', 'unknown']),
  models: z.array(z.string().min(1).max(128)).max(32).default([]),
  resetsAt: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
  durationMinutes: z.number().positive().finite().nullable(),
  usedPercent: z.number().nonnegative().finite().nullable(),
  status: z.enum(['allowed', 'blocked', 'unknown']),
  observedAt: z.number().int().nonnegative(),
});
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageWindowsObservationSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  source: z.enum(['claude-stream', 'codex-notification', 'codex-read']),
  observedAt: z.number().int().nonnegative(),
  windows: z.array(usageWindowSchema).max(128),
});
export type UsageWindowsObservation = z.infer<typeof usageWindowsObservationSchema>;

export const usageAccountBindingSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  accountId: z.string().min(1).max(256),
  profilePath: z.string().min(1).max(4096),
  /** SHA-256 of provider identity metadata, never an auth token. */
  identity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type UsageAccountBinding = z.infer<typeof usageAccountBindingSchema>;

export const usageWindowsSnapshotSchema = usageWindowsObservationSchema.extend({
  binding: usageAccountBindingSchema,
}).refine((s) => s.provider === s.binding.provider, 'Provider must match account binding');
export type UsageWindowsSnapshot = z.infer<typeof usageWindowsSnapshotSchema>;

/** One account's limit as the monitor sees it (spec 2026-11-15-usage-limit-fallback). */
export const usageLimitStateSchema = z.object({
  /** `provider:profileId`, the queue's account key. */
  account: z.string().min(1).max(320),
  provider: z.string().min(1).max(64),
  profileId: z.string().min(1).max(256),
  /** Remaining share of the tightest account-wide window, 0–100; null when no percentage is known. */
  remainingPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.number().int().positive().nullable(),
  windowId: z.string().max(256).nullable(),
  state: z.enum(['ok', 'low', 'exhausted']),
  observedAt: z.number().int().nonnegative(),
  /** The reset instant of the window whose LIMIT-LOW warning was already sent. */
  warnedResetsAt: z.number().int().positive().nullable(),
});
export type UsageLimitState = z.infer<typeof usageLimitStateSchema>;

export const usageLimitsResponseSchema = z.object({
  lowPercent: z.number(),
  keepRunning: z.number().int(),
  rampSeconds: z.number().int(),
  fallback: z.boolean(),
  accounts: z.array(usageLimitStateSchema),
});
export type UsageLimitsResponse = z.infer<typeof usageLimitsResponseSchema>;
