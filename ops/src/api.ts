import { z } from 'zod';
import {
  type Surface as GeneratedSurface,
  Surface as SurfaceValues,
} from './api-gen/surface';

const dateTimeSchema = z.iso.datetime({ offset: true });
const daySchema = z.iso.date();
const countSchema = z.number().int().nonnegative();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const surfaceSchema = z.enum(SurfaceValues);
export const thinkingLevelSchema = z.enum([
  'instant',
  'low',
  'mid',
  'high',
  'max',
]);
export const costGroupSchema = z.enum([
  'day',
  'user',
  'kind',
  'surface',
  'provider',
  'model',
  'thinking',
]);

const usagePointSchema = z.object({
  creditMicros: countSchema,
  day: daySchema,
  key: z.string(),
});

export const opsPermissionSchema = z.enum([
  'read_all',
  'execute_reconciliation_job',
  'write_registry',
]);

export const sessionSchema = z.object({
  permissions: z.array(z.string()),
  role: z.enum(['viewer', 'admin']),
  userId: z.string().min(1),
});

export function hasPermission(
  session: { permissions: readonly string[] },
  permission: z.infer<typeof opsPermissionSchema> | string
): boolean {
  return session.permissions.includes(permission);
}

export const overviewSchema = z.object({
  activeWorkspaces7d: countSchema,
  byKind: z.array(usagePointSchema),
  bySurface: z.array(usagePointSchema),
  dataAsOf: dateTimeSchema,
  jobs: z.object({
    failed24h: countSchema,
    queued: countSchema,
    running: countSchema,
  }),
  monthCredits: countSchema,
  signupsToday: countSchema,
  storageTotal: countSchema,
  todayCredits: countSchema,
  topStorage: z.array(
    z.object({
      email: z.string(),
      name: z.string(),
      usedBytes: countSchema,
      userId: z.string(),
    })
  ),
  topUsers: z.array(
    z.object({
      creditMicros: countSchema,
      email: z.string(),
      name: z.string(),
      planTier: z.string(),
      userId: z.string(),
    })
  ),
});

const turnLifecycleSchema = z.object({
  abandonedCalls: countSchema,
  appliedCalls: countSchema,
  latestCallOpenedAt: dateTimeSchema.nullable(),
  latestCallPurpose: z.string(),
  latestCallStatus: z.string(),
  messageId: z.string(),
  openCalls: countSchema,
  reservationExpiresAt: dateTimeSchema.nullable(),
  reservationId: z.string(),
  reservationStatus: z.string(),
  startedAt: dateTimeSchema,
  status: z.string(),
  surface: z.string(),
  traceId: z.string(),
  userId: z.string(),
});

export const healthSchema = z.object({
  abandonedCalls: z.array(
    z.object({
      callId: z.string(),
      contextConversationTokens: countSchema,
      contextCountingMethod: z.string(),
      contextCountingVersion: countSchema,
      contextSystemTokens: countSchema,
      contextToolTokens: countSchema,
      contextTotalTokens: countSchema,
      contextWindowTokens: countSchema,
      openedAt: dateTimeSchema,
      purpose: z.string(),
      reservationId: z.string(),
      reservationStatus: z.string(),
      surface: z.string(),
      thinking: z.string(),
      traceId: z.string(),
      turnStatus: z.string(),
      userId: z.string(),
    })
  ),
  activeTurns: z.array(turnLifecycleSchema),
  appliedWithoutUsage24h: countSchema,
  dataAsOf: dateTimeSchema,
  emailFailures24h: countSchema,
  expiredReservations: countSchema,
  failedTurns: z.array(turnLifecycleSchema),
  providerUsageWithoutCall24h: countSchema,
  reservationRatio24h: z.object({
    released: countSchema,
    releaseRate: z.number().nonnegative(),
    settled: countSchema,
  }),
  staleOpenCalls: countSchema,
  staleTurns: z.array(turnLifecycleSchema),
  stuckJobs: countSchema,
  turnsMissingApplied24h: countSchema,
});

export const parserMetricsSchema = z.object({
  attempts: z.object({
    attempts: countSchema,
    averageAttributedCpuCores: z.number().nonnegative(),
    cpuMilliseconds: countSchema,
    downloadMilliseconds: countSchema,
    elapsedMilliseconds: countSchema,
    ioReadBytes: countSchema,
    ioWriteBytes: countSchema,
    ocrPages: countSchema,
    pages: countSchema,
    peakWorkerPssBytes: countSchema,
    peakWorkerRssBytes: countSchema,
    queueMilliseconds: countSchema,
    uploadMilliseconds: countSchema,
  }),
  dataAsOf: dateTimeSchema,
  hours: z.number().int().min(1).max(168),
  samples: z.array(
    z.object({
      activeJobs: countSchema,
      cpuPercent: z.number().min(0).max(100),
      hostId: z.string(),
      load1: z.number().nonnegative(),
      memoryTotalBytes: countSchema,
      memoryUsedBytes: countSchema,
      networkRxBytes: countSchema,
      networkTxBytes: countSchema,
      parserMemoryBytes: countSchema,
      parserPssBytes: countSchema,
      queuedJobs: countSchema,
      sampledAt: dateTimeSchema,
      swapUsedBytes: countSchema,
    })
  ),
});

const reconciliationReportSchema = z.object({
  actorUserId: z.string(),
  createdAt: dateTimeSchema,
  eventType: z.string(),
  id: countSchema,
  metadata: jsonObjectSchema,
  runId: countSchema,
  subjectId: z.string(),
  subjectType: z.string(),
});

const reconciliationRunSchema = z.object({
  error: z.string(),
  errorCount: countSchema,
  finishedAt: dateTimeSchema.nullable(),
  id: countSchema,
  jobType: z.string(),
  repairedCount: countSchema,
  requestedAt: dateTimeSchema,
  requestedById: z.string(),
  requestedByName: z.string(),
  scannedCount: countSchema,
  startedAt: dateTimeSchema.nullable(),
  status: z.string(),
  trigger: z.string(),
});

export const reconciliationStatusSchema = z.object({
  dataAsOf: dateTimeSchema,
  reports: z.array(reconciliationReportSchema),
  runs: z.array(reconciliationRunSchema),
});

export const reconciliationRequestSchema = z.object({
  alreadyQueued: z.boolean(),
  requestedAt: dateTimeSchema,
  runId: countSchema,
});

export const operatorAuditEventSchema = z.object({
  action: z.string().min(1),
  actorRole: z.string().min(1),
  actorUserId: z.string().min(1),
  id: z.number().int().positive(),
  metadata: jsonObjectSchema,
  occurredAt: dateTimeSchema,
  outcome: z.string().min(1),
  targetId: z.string(),
  targetType: z.string().min(1),
  traceId: z.string(),
});

export const operatorAuditPageSchema = z.object({
  events: z.array(operatorAuditEventSchema),
  nextBeforeId: z.number().int().positive().optional(),
});

export const userSearchSchema = z.array(
  z.object({
    accountState: z.string(),
    email: z.string(),
    name: z.string(),
    planTier: z.string(),
    userId: z.string(),
  })
);

export const userDetailSchema = z.object({
  accountState: z.string(),
  credits: z.object({
    limitMicros: countSchema,
    periodStart: daySchema,
    reservedMicros: countSchema,
    usedMicros: countSchema,
  }),
  dataAsOf: dateTimeSchema,
  email: z.string(),
  name: z.string(),
  planTier: z.string(),
  recentUsage: z.array(
    z.object({
      cacheAnomaly: z.string(),
      cachedReadTokens: countSchema,
      cacheWriteTokens: countSchema,
      catalogModelSlug: z.string(),
      catalogProviderSlug: z.string(),
      contextConversationTokens: countSchema,
      contextCountingMethod: z.string(),
      contextCountingVersion: countSchema,
      contextSystemTokens: countSchema,
      contextToolTokens: countSchema,
      contextTotalTokens: countSchema,
      contextWindowTokens: countSchema,
      createdAt: dateTimeSchema,
      creditMicros: countSchema,
      inputTokens: countSchema,
      kind: z.string(),
      model: z.string(),
      modelVersion: countSchema,
      outputTokens: countSchema,
      paidBy: z.string(),
      parseCpuMilliseconds: countSchema,
      parseElapsedMilliseconds: countSchema,
      parseOcrPages: countSchema,
      parsePages: countSchema,
      provider: z.string(),
      providerCallId: z.string(),
      providerCallStatus: z.string(),
      purpose: z.string(),
      reasoningTokens: countSchema,
      surface: z.string(),
      thinking: z.string(),
      traceId: z.string(),
    })
  ),
  storage: z.object({
    limitBytes: countSchema,
    reservedBytes: countSchema,
    usedBytes: countSchema,
  }),
  usageByKind: z.array(usagePointSchema),
  userId: z.string(),
  workspaces: z.array(
    z.object({
      fileCount: countSchema,
      id: z.string(),
      lastActivityAt: dateTimeSchema,
      name: z.string(),
    })
  ),
});

const costRowSchema = z.object({
  cachedReadTokens: countSchema,
  cacheWriteTokens: countSchema,
  contextConversationTokens: countSchema,
  contextSystemTokens: countSchema,
  contextToolTokens: countSchema,
  contextTotalTokens: countSchema,
  creditMicros: countSchema,
  events: countSchema,
  inputTokens: countSchema,
  key: z.string(),
  observed: z.string(),
  outputTokens: countSchema,
  parseCpuMilliseconds: countSchema,
  parseElapsedMilliseconds: countSchema,
  parseOcrPages: countSchema,
  parsePages: countSchema,
  reasoningTokens: countSchema,
});

export const costReportSchema = z.object({
  bucket: z.enum(['day', 'month']),
  contextSummary: z.object({
    calls: countSchema,
    callsAtLeast80Percent: countSchema,
    callsAtLeast90Percent: countSchema,
    callsAtLeast95Percent: countSchema,
    conversationTokens: countSchema,
    maxWindowUtilization: z.number().nonnegative(),
    p50WindowUtilization: z.number().nonnegative(),
    p95WindowUtilization: z.number().nonnegative(),
    systemTokens: countSchema,
    toolTokens: countSchema,
    totalTokens: countSchema,
    windowTokens: countSchema,
  }),
  dataAsOf: dateTimeSchema,
  from: daySchema,
  rows: z.array(costRowSchema),
  to: daySchema,
});

export const catalogConfigSchema = z.object({
  byokEnabled: z.boolean(),
  contextWindowTokens: countSchema,
  createdAt: dateTimeSchema,
  createdBy: z.string(),
  defaultThinking: z.string(),
  embeddingDefaultEligible: z.boolean(),
  embeddingValidationError: z.string(),
  enabled: z.boolean(),
  isDefaultFor: z.array(surfaceSchema),
  microsPerCachedInputToken: countSchema,
  microsPerInputToken: countSchema,
  microsPerOutputToken: countSchema,
  modelName: z.string().min(1),
  modelSlug: z.string().min(1),
  params: jsonObjectSchema,
  platformEnabled: z.boolean(),
  providerName: z.string().min(1),
  providerSlug: z.string().min(1),
  surfaces: z.array(surfaceSchema),
  thinkingLevels: z.array(thinkingLevelSchema),
  updatedAt: dateTimeSchema,
  updatedBy: z.string(),
  version: z.number().int().positive(),
});

export const registrySchema = z.object({
  aliasesAllowed: z.boolean(),
  configs: z.array(catalogConfigSchema),
  embeddingWorkspaceCounts: z.array(
    z.object({
      count: countSchema,
      dim: z.number().int().positive(),
      modelSlug: z.string(),
      providerSlug: z.string(),
      version: z.number().int().positive(),
    })
  ),
  providerCredentials: z.array(
    z.object({
      configured: z.boolean(),
      environment: z.string(),
      providerSlug: z.string(),
    })
  ),
  revision: countSchema,
  surfaces: z.array(surfaceSchema),
});

export const draftConfigSchema = z.object({
  byokEnabled: z.boolean(),
  contextWindowTokens: countSchema,
  defaultThinking: z.string(),
  id: z.string().min(1),
  microsPerCachedInputToken: countSchema,
  microsPerInputToken: countSchema,
  microsPerOutputToken: countSchema,
  modelName: z.string().min(1),
  modelSlug: z.string().min(1),
  params: jsonObjectSchema,
  platformEnabled: z.boolean(),
  providerName: z.string().min(1),
  providerSlug: z.string().min(1),
  thinkingLevels: z.array(thinkingLevelSchema),
});

const activeConfigSchema = draftConfigSchema
  .omit({ id: true })
  .extend({
    defaultFor: z.array(surfaceSchema),
    rates: z.object({
      cachedInputMicros: countSchema,
      inputMicros: countSchema,
      outputMicros: countSchema,
    }),
    surfaces: z.array(surfaceSchema).min(1),
  })
  .omit({
    microsPerCachedInputToken: true,
    microsPerInputToken: true,
    microsPerOutputToken: true,
  });

export const registrySaveRequestSchema = z.object({
  acknowledgeEmbeddingRetarget: z.boolean(),
  active: z.array(activeConfigSchema),
  revision: countSchema,
});
const apiErrorSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  modelSlug: z.string().optional(),
  reason: z.string().optional(),
  surface: z.string().optional(),
});

export const eliteLLMProviderSchema = z.object({
  byok: z.boolean(),
  modes: z.array(z.string()),
  name: z.string(),
  platformEnv: z.string(),
  slug: z.string(),
  thinking: z.array(thinkingLevelSchema),
});

export const eliteLLMProviderPageSchema = z.object({
  providers: z.array(eliteLLMProviderSchema),
});

export type Session = z.infer<typeof sessionSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Health = z.infer<typeof healthSchema>;
export type ParserMetrics = z.infer<typeof parserMetricsSchema>;
export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;
export type ReconciliationRequest = z.infer<typeof reconciliationRequestSchema>;
export type OperatorAuditEvent = z.infer<typeof operatorAuditEventSchema>;
export type OperatorAuditPage = z.infer<typeof operatorAuditPageSchema>;
export type UserSearchResult = z.infer<typeof userSearchSchema>[number];
export type UserDetail = z.infer<typeof userDetailSchema>;
export type CostGroup = z.infer<typeof costGroupSchema>;
export type CostReport = z.infer<typeof costReportSchema>;
export type CostRow = z.infer<typeof costRowSchema>;
export type Surface = GeneratedSurface;
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;
export type Registry = z.infer<typeof registrySchema>;
export type DraftConfig = z.infer<typeof draftConfigSchema>;
export type RegistrySaveRequest = z.infer<typeof registrySaveRequestSchema>;
export type EliteLLMProvider = z.infer<typeof eliteLLMProviderSchema>;
export type EliteLLMProviderPage = z.infer<typeof eliteLLMProviderPageSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export class OpsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpsApiError';
    this.status = status;
  }
}

type ApiOptions = {
  getToken: () => Promise<string | null>;
  fetcher?: typeof fetch;
};

async function errorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(payload);
  if (parsed.success) {
    const parts = [
      parsed.data.message ?? parsed.data.error,
      parsed.data.reason,
      parsed.data.modelSlug
        ? `${parsed.data.code ?? 'error'}: ${parsed.data.modelSlug}`
        : parsed.data.code,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) {
      return parts.join(' — ');
    }
  }
  return `Request failed with status ${response.status}`;
}

export function createOpsApi({ getToken, fetcher = fetch }: ApiOptions) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit
  ): Promise<T> {
    const token = await getToken();
    if (!token) {
      throw new OpsApiError(401, 'A Clerk session is required.');
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init?.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetcher(`/api/ops${path}`, { ...init, headers });
    if (!response.ok) {
      throw new OpsApiError(response.status, await errorMessage(response));
    }
    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new OpsApiError(
        502,
        `The ops API returned an invalid response: ${z.prettifyError(parsed.error)}`
      );
    }
    return parsed.data;
  }

  return {
    audit: (beforeId?: number) => {
      const search = new URLSearchParams({ limit: '100' });
      if (beforeId !== undefined) {
        search.set('beforeId', String(beforeId));
      }
      return request(`/audit?${search}`, operatorAuditPageSchema);
    },
    costs: (
      from: string,
      to: string,
      groupBy: CostGroup,
      bucket: 'day' | 'month'
    ) => {
      const search = new URLSearchParams({ bucket, from, groupBy, to });
      return request(`/costs?${search}`, costReportSchema);
    },
    health: () => request('/health', healthSchema),
    overview: () => request('/overview', overviewSchema),
    parserMetrics: (hours = 24) =>
      request(
        `/parser?${new URLSearchParams({ hours: String(hours) })}`,
        parserMetricsSchema
      ),
    providers: () => request('/providers', eliteLLMProviderPageSchema),
    reconciliation: () =>
      request('/reconciliation', reconciliationStatusSchema),
    registry: () => request('/registry', registrySchema),
    requestReconciliation: (jobType: 'storage' | 'stripe') =>
      request(`/reconciliation/${jobType}`, reconciliationRequestSchema, {
        method: 'POST',
      }),
    saveRegistry: (body: RegistrySaveRequest) =>
      request('/registry/save', registrySchema, {
        body: JSON.stringify(body),
        method: 'POST',
      }),
    searchUsers: (query: string) =>
      request(
        `/users/search?${new URLSearchParams({ q: query })}`,
        userSearchSchema
      ),
    session: () => request('/session', sessionSchema),
    user: (userId: string) =>
      request(`/users/${encodeURIComponent(userId)}`, userDetailSchema),
  };
}

export type OpsApi = ReturnType<typeof createOpsApi>;
