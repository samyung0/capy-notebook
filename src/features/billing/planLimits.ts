import type { PlanTier } from '@/api/types';

export interface PlanLimits {
  creditLimitMicros: number;
  filesPerUpload: number;
  filesPerWorkspace: number;
  imageMaxBytes: number;
  ownedWorkspaceLimit: number | null;
  sourceFileMaxBytes: number;
  storageLimitBytes: number;
}

/**
 * Explicit product-copy snapshot of `plan_limits` (initial schema plus 0069, 0070 and 0114,
 * Pro's 10,000 credits set directly in UAT on 2026-10-15, and Free's 200 monthly
 * credits set there on 2026-10-16; the 800-credit starter grant comes with the first saved card, migration 0109).
 * This is intentionally not fetched through an API. Changing a value is an
 * explicit product action: update the SQL seed, this file, and any affected
 * Paraglide translations together.
 */
export const PLAN_LIMITS = {
  free: {
    creditLimitMicros: 200_000_000,
    filesPerUpload: 20,
    filesPerWorkspace: 100,
    imageMaxBytes: 2_097_152,
    ownedWorkspaceLimit: 10,
    sourceFileMaxBytes: 10_485_760,
    storageLimitBytes: 100_000_000,
  },
  pro: {
    creditLimitMicros: 10_000_000_000,
    filesPerUpload: 20,
    filesPerWorkspace: 100,
    imageMaxBytes: 2_097_152,
    ownedWorkspaceLimit: 50,
    sourceFileMaxBytes: 31_457_280,
    storageLimitBytes: 1_000_000_000,
  },
} as const satisfies Record<PlanTier, PlanLimits>;
