import { z } from 'zod';
import { type Slot as GeneratedSlot, Slot as SlotValues } from './api-gen/slot';

const dateTimeSchema = z.iso.datetime({ offset: true });
const daySchema = z.iso.date();
const countSchema = z.number().int().nonnegative();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const slotSchema = z.enum(SlotValues);
// Operator-settable capabilities come from the registry snapshot so a new
// capability in Go reaches the dashboard without a release here.
export const capabilitySchema = z.string().min(1);
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
      errorCode: z.string(),
      model: z.string(),
      openedAt: dateTimeSchema,
      provider: z.string(),
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
  busyCalls: z.array(
    z.object({
      calls: countSchema,
      model: z.string(),
      provider: z.string(),
    })
  ),
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

export const ingestHostMetricsSchema = z.object({
  dataAsOf: dateTimeSchema,
  environments: z.array(
    z.object({
      attempts: z.object({
        abandonedProviderCalls: countSchema,
        attempts: countSchema,
        averageDurationMilliseconds: countSchema,
        averageQueueMilliseconds: countSchema,
        capacityWaits: countSchema,
        chunksCreated: countSchema,
        failed: countSchema,
        figuresCached: countSchema,
        figuresCaptioned: countSchema,
        figuresFailed: countSchema,
        figuresSelected: countSchema,
        inputTokens: countSchema,
        leaseExpired: countSchema,
        ocrPages: countSchema,
        outputTokens: countSchema,
        p95DurationMilliseconds: countSchema,
        p95QueueMilliseconds: countSchema,
        pages: countSchema,
        providerCalls: countSchema,
        retrying: countSchema,
        slices: countSchema,
        succeeded: countSchema,
      }),
      dataAsOf: dateTimeSchema,
      environment: z.string().min(1),
      errors: z.array(
        z.object({
          category: z.string(),
          code: z.string(),
          count: countSchema,
          stage: z.string(),
        })
      ),
      lastJobActivityAt: dateTimeSchema.nullable(),
      queue: z.object({
        expiredLeases: countSchema,
        importDelayed: countSchema,
        importReady: countSchema,
        importRunning: countSchema,
        ingestDelayed: countSchema,
        ingestReady: countSchema,
        ingestRunning: countSchema,
        oldestQueuedMilliseconds: countSchema,
        parseDelayed: countSchema,
        parseReady: countSchema,
        parseRunning: countSchema,
      }),
      recentAttempts: z.array(
        z.object({
          abandonedProviderCalls: countSchema,
          attempt: countSchema,
          chunksCreated: countSchema,
          claimedAt: dateTimeSchema,
          durationMilliseconds: countSchema,
          errorCategory: z.string(),
          errorCode: z.string(),
          figuresCaptioned: countSchema,
          figuresFailed: countSchema,
          finishedAt: dateTimeSchema.nullable(),
          id: countSchema,
          jobId: z.string(),
          jobType: z.string(),
          nextRetryAt: dateTimeSchema.nullable(),
          ocrPages: countSchema,
          operationId: z.string(),
          pages: countSchema,
          providerCalls: countSchema,
          queueMilliseconds: countSchema,
          retryable: z.boolean(),
          route: z.string(),
          slices: countSchema,
          sourceFormat: z.string(),
          stage: z.string(),
          stageTimings: z.record(z.string(), countSchema),
          status: z.string(),
        })
      ),
      samples: z.array(
        z.object({
          activeJobs: countSchema,
          activeSlices: countSchema,
          cpuPercent: z.number().min(0).max(100),
          diskFreeBytes: countSchema,
          expiredLeases: countSchema,
          hostId: z.string(),
          hostMetricsAvailable: z.boolean(),
          ingestDelayedJobs: countSchema,
          ingestReadyJobs: countSchema,
          ingestRunningJobs: countSchema,
          lastSliceCompletedAgeMilliseconds: countSchema,
          load1: z.number().nonnegative(),
          memoryTotalBytes: countSchema,
          memoryUsedBytes: countSchema,
          networkRxBytes: countSchema,
          networkTxBytes: countSchema,
          oldestActiveSliceMilliseconds: countSchema,
          oldestQueuedJobMilliseconds: countSchema,
          oldestQueuedSliceMilliseconds: countSchema,
          parseDelayedJobs: countSchema,
          parseReadyJobs: countSchema,
          parseRunningJobs: countSchema,
          parserMemoryBytes: countSchema,
          parserMemoryPeakBytes: countSchema,
          parserOomKillEvents: countSchema,
          parserPssBytes: countSchema,
          queuedJobs: countSchema,
          queuedSlices: countSchema,
          releaseSha: z.string(),
          sampledAt: dateTimeSchema,
          spoolBytes: countSchema,
          spoolFiles: countSchema,
          swapUsedBytes: countSchema,
        })
      ),
      workerSamples: z.array(
        z.object({
          busyWorkers: countSchema,
          cpuCores: z.number().nonnegative(),
          memoryBytes: countSchema,
          memoryLimitBytes: countSchema,
          oomKillEvents: countSchema,
          role: z.string(),
          sampledAt: dateTimeSchema,
          workerCount: countSchema,
        })
      ),
      workers: z.array(
        z.object({
          cpuCores: z.number().nonnegative(),
          hostId: z.string(),
          jobAttemptId: countSchema.nullable(),
          memoryBytes: countSchema,
          memoryLimitBytes: countSchema,
          oomEvents: countSchema,
          oomKillEvents: countSchema,
          pidsCurrent: countSchema,
          pidsLimit: countSchema,
          releaseSha: z.string(),
          role: z.string(),
          sampledAt: dateTimeSchema,
          stage: z.string(),
          stale: z.boolean(),
          state: z.string(),
          workerInstanceId: z.string(),
        })
      ),
    })
  ),
  hours: z.number().int().min(1).max(168),
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

export const resourceCreditRateSchema = z.object({
  active: z.boolean(),
  createdAt: dateTimeSchema,
  creditMicrosPerUnit: countSchema,
  resourceKey: z.string(),
  unit: z.string(),
  version: z.number().int().positive(),
});

export const resourceCreditRatesSchema = z.array(resourceCreditRateSchema);
export type ResourceCreditRate = z.infer<typeof resourceCreditRateSchema>;

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
      toolCalls: z.array(
        z.object({
          detail: z.string(),
          name: z.string(),
          outcome: z.string(),
        })
      ),
      traceId: z.string(),
    })
  ),
  sessionRevocationAttempts: countSchema,
  sessionRevocationDueAt: dateTimeSchema.optional(),
  sessionRevocationError: z.string(),
  sessionRevocationPending: z.boolean(),
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

const providerAttemptRowSchema = z.object({
  abandoned: countSchema,
  applied: countSchema,
  attempts: countSchema,
  busy: countSchema,
  cachedReadTokens: countSchema,
  cacheWriteTokens: countSchema,
  creditMicros: countSchema,
  inputTokens: countSchema,
  model: z.string(),
  open: countSchema,
  outputTokens: countSchema,
  provider: z.string(),
  reasoningTokens: countSchema,
});

export const costReportSchema = z.object({
  attempts: z.array(providerAttemptRowSchema),
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

export const capacitySchema = z
  .object({
    concurrencyTotal: z.number().int().positive(),
    interactiveReserve: z.number().int().nonnegative(),
  })
  .refine((value) => value.interactiveReserve < value.concurrencyTotal, {
    message: 'Reserve must be below total concurrency.',
    path: ['interactiveReserve'],
  });
export type CapacityFields = z.infer<typeof capacitySchema>;

export const catalogConfigSchema = z.object({
  byokEnabled: z.boolean(),
  capabilities: z.array(capabilitySchema),
  concurrencyTotal: z.number().int().positive().nullable(),
  contextWindowTokens: countSchema,
  createdAt: dateTimeSchema,
  createdBy: z.string(),
  defaultThinking: z.string(),
  embeddingDefaultEligible: z.boolean(),
  embeddingValidationError: z.string(),
  enabled: z.boolean(),
  interactiveReserve: countSchema.nullable(),
  isDefaultFor: z.array(slotSchema),
  microsPerCachedInputToken: countSchema,
  microsPerInputToken: countSchema,
  microsPerOutputToken: countSchema,
  modelName: z.string().min(1),
  modelSlug: z.string().min(1),
  params: jsonObjectSchema,
  platformEnabled: z.boolean(),
  providerName: z.string().min(1),
  providerSlug: z.string().min(1),
  slots: z.array(slotSchema),
  thinkingLevels: z.array(thinkingLevelSchema),
  updatedAt: dateTimeSchema,
  updatedBy: z.string(),
  version: z.number().int().positive(),
});

export const registrySchema = z.object({
  aliasesAllowed: z.boolean(),
  capabilities: z.array(capabilitySchema),
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
  slots: z.array(slotSchema),
});

export const draftConfigSchema = z.object({
  byokEnabled: z.boolean(),
  capabilities: z.array(capabilitySchema),
  concurrencyTotal: z.number().int().positive().nullable(),
  contextWindowTokens: countSchema,
  defaultThinking: z.string(),
  id: z.string().min(1),
  interactiveReserve: countSchema.nullable(),
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
    defaultFor: z.array(slotSchema),
    rates: z.object({
      cachedInputMicros: countSchema,
      inputMicros: countSchema,
      outputMicros: countSchema,
    }),
    slots: z.array(slotSchema).min(1),
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
  slot: z.string().optional(),
});

// Knowledge library, read only. The shapes follow LIBRARY_SCHEMA, owned by
// pipeline/pipeline/retrieval/library.py.
// The role vocabulary the library tags with, in the order a learner meets it.
export const libraryRoles = [
  'introduction',
  'formal',
  'worked_example',
  'exercise',
  'summary',
  'reference',
] as const;

// The live library: one workspace, one file per book, each book at its own
// version. Counts are the current version's.
export const libraryOverviewSchema = z.object({
  books: countSchema,
  chunks: countSchema,
  dataAsOf: dateTimeSchema,
  excerpts: countSchema,
  figures: countSchema,
  topics: countSchema,
});

const libraryBookVersionSchema = z.object({
  chunkerVersion: z.string(),
  corpusIdentity: z.string(),
  descriptor: z.string(),
  note: z.string(),
  objectKey: z.string(),
  parserFingerprint: z.string(),
  parserRelease: z.string(),
  publishedAt: dateTimeSchema,
  sourceRun: z.string(),
  status: z.string(),
  summary: z.string(),
  version: countSchema,
});

export const libraryBooksSchema = z.array(
  z.object({
    attribution: z.string(),
    authors: z.unknown(),
    bytes: countSchema,
    chunkCount: countSchema,
    contentId: z.string(),
    descriptor: z.string(),
    downloadUrl: z.string(),
    edition: z.string(),
    excerptCount: countSchema,
    figureCount: countSchema,
    figureExclusions: z.unknown(),
    firstContentPage: countSchema,
    id: z.string().min(1),
    license: z.string(),
    licenseUrl: z.string(),
    pages: countSchema,
    rightsNotes: z.unknown(),
    sha256: z.string(),
    sourceUrl: z.string(),
    summary: z.string(),
    title: z.string(),
    version: countSchema,
    versions: z.array(libraryBookVersionSchema),
  })
);

// The committed subjects fixture with what the live library holds under each.
export const librarySubjectsSchema = z.array(
  z.object({
    area: z.string(),
    excerpts: countSchema,
    id: z.string().min(1),
    label: z.string(),
    topics: countSchema,
  })
);

export const libraryTopicsSchema = z.array(
  z.object({
    aliases: z.unknown(),
    byRole: z.record(z.string(), countSchema),
    id: z.string().min(1),
    label: z.string(),
    retrievableByRole: z.record(z.string(), countSchema),
    scope: z.string(),
    sourceSections: z.string(),
    subjectId: z.string().min(1),
    verifiedByRole: z.record(z.string(), countSchema),
  })
);

const libraryExcerptSchema = z.object({
  bookId: z.string(),
  bookTitle: z.string(),
  chunkIds: z.array(z.string()),
  confidence: z.number().nullable(),
  evidenceVerified: z.boolean(),
  figureIds: z.array(z.string()),
  id: z.string().min(1),
  pages: z.array(z.number().int()),
  proposedTopic: z.string(),
  reviewReasons: z.array(z.string()),
  roles: z.array(z.string()),
  sectionPath: z.string(),
  synopsis: z.string(),
  tagStatus: z.string(),
  topicIds: z.array(z.string()),
});

export const libraryExcerptPageSchema = z.object({
  items: z.array(libraryExcerptSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: countSchema,
});

const libraryChunkSchema = z.object({
  confidence: z.number().nullable(),
  confidenceReasons: z.array(z.string()),
  id: z.string(),
  index: z.number().int().nonnegative(),
  lang: z.string(),
  pageEnd: z.number().int().nullable(),
  pageStart: z.number().int().nullable(),
  reference: z.boolean(),
  regions: z.unknown(),
  searchable: z.boolean(),
  sectionPath: z.string(),
  text: z.string(),
});

const libraryFigureSchema = z.object({
  bbox: z.array(z.number().int()),
  blockIndex: z.number().int(),
  captionBbox: z.array(z.number().int()).nullable(),
  capturePath: z.string(),
  capturePixelSize: z.array(z.number().int()).nullable(),
  excluded: z.boolean(),
  exclusionEvidence: z.unknown(),
  geometryKind: z.string(),
  id: z.string(),
  originalCaption: z.unknown(),
  originalFootnote: z.unknown(),
  page: z.number().int(),
  sectionPath: z.string(),
  space: z.string(),
});

export const libraryExcerptDetailSchema = z.object({
  book: z.object({
    chunkerVersion: z.string(),
    downloadUrl: z.string(),
    edition: z.string(),
    firstContentPage: countSchema,
    id: z.string(),
    license: z.string(),
    parserFingerprint: z.string(),
    sha256: z.string(),
    sourceUrl: z.string(),
    title: z.string(),
    version: countSchema,
  }),
  chunks: z.array(libraryChunkSchema),
  evidence: z.string(),
  excerpt: libraryExcerptSchema,
  figures: z.array(libraryFigureSchema),
  regions: z.unknown(),
  text: z.string(),
});

export const libraryModelRunsSchema = z.array(
  z.object({
    approximateCostUsd: z.number().nullable(),
    attempts: z.number().int().nonnegative(),
    bookId: z.string(),
    collection: z.unknown(),
    model: z.string(),
    requestEndUtc: z.string(),
    requestStartUtc: z.string(),
    resultsPath: z.string(),
    stage: z.string(),
    transport: z.string(),
    usage: z.unknown(),
    version: countSchema,
  })
);

export const eliteLLMProviderSchema = z.object({
  byok: z.boolean(),
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
export type IngestHostMetrics = z.infer<typeof ingestHostMetricsSchema>;
export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;
export type ReconciliationRequest = z.infer<typeof reconciliationRequestSchema>;
export type OperatorAuditEvent = z.infer<typeof operatorAuditEventSchema>;
export type OperatorAuditPage = z.infer<typeof operatorAuditPageSchema>;
export type UserSearchResult = z.infer<typeof userSearchSchema>[number];
export type UserDetail = z.infer<typeof userDetailSchema>;
export type CostGroup = z.infer<typeof costGroupSchema>;
export type CostReport = z.infer<typeof costReportSchema>;
export type CostRow = z.infer<typeof costRowSchema>;
export type Slot = GeneratedSlot;
export type Capability = z.infer<typeof capabilitySchema>;
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;
export type Registry = z.infer<typeof registrySchema>;
export type DraftConfig = z.infer<typeof draftConfigSchema>;
export type RegistrySaveRequest = z.infer<typeof registrySaveRequestSchema>;
export type LibraryOverview = z.infer<typeof libraryOverviewSchema>;
export type LibraryBook = z.infer<typeof libraryBooksSchema>[number];
export type LibraryBookVersion = z.infer<typeof libraryBookVersionSchema>;
export type LibrarySubject = z.infer<typeof librarySubjectsSchema>[number];
export type LibraryTopic = z.infer<typeof libraryTopicsSchema>[number];
export type LibraryExcerpt = z.infer<typeof libraryExcerptSchema>;
export type LibraryExcerptPage = z.infer<typeof libraryExcerptPageSchema>;
export type LibraryExcerptDetail = z.infer<typeof libraryExcerptDetailSchema>;
export type LibraryModelRun = z.infer<typeof libraryModelRunsSchema>[number];
export type LibraryExcerptFilters = {
  book?: string;
  page?: number;
  review?: boolean;
  role?: string;
  topic?: string;
};
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

const attachmentFileName = /filename="([^"]+)"/;

export function fileNameFrom(disposition: string | null): string {
  const match = disposition?.match(attachmentFileName);
  return match ? match[1] : 'library-export.json';
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

  async function download(path: string) {
    const token = await getToken();
    if (!token) {
      throw new OpsApiError(401, 'A Clerk session is required.');
    }
    const response = await fetcher(`/api/ops${path}`, {
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    });
    if (!response.ok) {
      throw new OpsApiError(response.status, await errorMessage(response));
    }
    return {
      blob: await response.blob(),
      digest: response.headers.get('X-Capy-Export-Sha256') ?? '',
      fileName: fileNameFrom(response.headers.get('Content-Disposition')),
    };
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
    ingestHostMetrics: (hours = 24) =>
      request(
        `/ingest-host?${new URLSearchParams({ hours: String(hours) })}`,
        ingestHostMetricsSchema
      ),
    libraryBooks: () => request('/library/books', libraryBooksSchema),
    libraryExcerpt: (excerptId: string) =>
      request(
        `/library/excerpts/${encodeURIComponent(excerptId)}`,
        libraryExcerptDetailSchema
      ),
    libraryExcerpts: (filters: LibraryExcerptFilters = {}) => {
      const search = new URLSearchParams({ page: String(filters.page ?? 1) });
      for (const [key, value] of [
        ['book', filters.book],
        ['topic', filters.topic],
        ['role', filters.role],
      ] as const) {
        if (value) {
          search.set(key, value);
        }
      }
      if (filters.review) {
        search.set('review', 'true');
      }
      return request(`/library/excerpts?${search}`, libraryExcerptPageSchema);
    },
    // The export is a file a reviewer keeps, so it stays raw bytes; the digest
    // header travels with it. No version means the book's current one.
    libraryExport: (bookId: string, version?: number) =>
      download(
        `/library/export/${encodeURIComponent(bookId)}${version ? `?version=${version}` : ''}`
      ),
    libraryModelRuns: () =>
      request('/library/model-runs', libraryModelRunsSchema),
    libraryOverview: () => request('/library', libraryOverviewSchema),
    librarySubjects: () => request('/library/subjects', librarySubjectsSchema),
    libraryTopics: () => request('/library/topics', libraryTopicsSchema),
    overview: () => request('/overview', overviewSchema),
    providers: () => request('/providers', eliteLLMProviderPageSchema),
    reconciliation: () =>
      request('/reconciliation', reconciliationStatusSchema),
    registry: () => request('/registry', registrySchema),
    requestReconciliation: (jobType: 'storage' | 'stripe') =>
      request(`/reconciliation/${jobType}`, reconciliationRequestSchema, {
        method: 'POST',
      }),
    resourceCreditRates: () =>
      request('/resource-rates', resourceCreditRatesSchema),
    saveRegistry: (body: RegistrySaveRequest) =>
      request('/registry/save', registrySchema, {
        body: JSON.stringify(body),
        method: 'POST',
      }),
    saveResourceCreditRate: (
      resourceKey: string,
      creditMicrosPerUnit: number
    ) =>
      request(
        `/resource-rates/${encodeURIComponent(resourceKey)}`,
        resourceCreditRateSchema,
        {
          body: JSON.stringify({ creditMicrosPerUnit }),
          method: 'POST',
        }
      ),
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
