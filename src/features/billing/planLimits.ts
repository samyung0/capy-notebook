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
 * Explicit product-copy snapshot of `plan_limits` (initial schema plus 0069).
 * This is intentionally not fetched through an API. Changing a value is an
 * explicit product action: update the SQL seed, this file, and any affected
 * Paraglide translations together.
 */
export const PLAN_LIMITS = {
  free: {
    creditLimitMicros: 1_000_000_000,
    filesPerUpload: 20,
    filesPerWorkspace: 100,
    imageMaxBytes: 2_097_152,
    ownedWorkspaceLimit: null,
    sourceFileMaxBytes: 10_485_760,
    storageLimitBytes: 100_000_000,
  },
  pro: {
    creditLimitMicros: 20_000_000_000,
    filesPerUpload: 20,
    filesPerWorkspace: 100,
    imageMaxBytes: 5_242_880,
    ownedWorkspaceLimit: null,
    sourceFileMaxBytes: 31_457_280,
    storageLimitBytes: 1_000_000_000,
  },
} as const satisfies Record<PlanTier, PlanLimits>;
