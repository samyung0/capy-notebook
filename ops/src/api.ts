import { z } from 'zod';

const dateTimeSchema = z.iso.datetime({ offset: true });
const daySchema = z.iso.date();
const countSchema = z.number().int().nonnegative();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const surfaceSchema = z.enum([
  'chat',
  'generate',
  'editor',
  'quiz',
  'ingest',
  'embedding',
  'vision',
]);
export const authModeSchema = z.enum([
  'platform',
  'user_key',
  'platform_or_user',
]);
export const costGroupSchema = z.enum([
  'day',
  'user',
  'kind',
  'surface',
  'provider',
  'model',
]);

const usagePointSchema = z.object({
  creditMicros: countSchema,
  day: daySchema,
  key: z.string(),
});

export const sessionSchema = z.object({
  role: z.enum(['viewer', 'admin']),
  userId: z.string().min(1),
});

export const overviewSchema = z.object({
  activeWorkspaces7d: countSchema,
  byKind: z.array(usagePointSchema),
  bySurface: z.array(usagePointSchema),
  jobs: z.object({
    failed24h: countSchema,
    queued: countSchema,
    running: countSchema,
  }),
  monthCredits: countSchema,
  rollupLastRunAt: dateTimeSchema.nullable().optional(),
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

export const healthSchema = z.object({
  emailFailures24h: countSchema,
  expiredReservations: countSchema,
  reservationRatio24h: z.object({
    released: countSchema,
    releaseRate: z.number().nonnegative(),
    settled: countSchema,
  }),
  rollupLastRunAt: dateTimeSchema.nullable(),
  rollupStale: z.boolean(),
  stuckJobs: countSchema,
  usageMissing24h: countSchema,
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
  email: z.string(),
  name: z.string(),
  planTier: z.string(),
  recentUsage: z.array(
    z.object({
      createdAt: dateTimeSchema,
      creditMicros: countSchema,
      inputTokens: countSchema,
      kind: z.string(),
      metadata: z.unknown(),
      model: z.string(),
      modelKey: z.string(),
      modelVersion: countSchema,
      outputTokens: countSchema,
      provider: z.string(),
      surface: z.string(),
      traceId: z.string(),
      unit: z.string(),
      units: countSchema,
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

export const costRowsSchema = z.array(
  z.object({
    creditMicros: countSchema,
    events: countSchema,
    inputTokens: countSchema,
    key: z.string(),
    outputTokens: countSchema,
    units: countSchema,
  })
);

export const catalogConfigSchema = z.object({
  authMode: authModeSchema,
  baseUrl: z.string(),
  contextWindowTokens: countSchema,
  createdAt: dateTimeSchema,
  displayName: z.string().min(1),
  embeddingDefaultEligible: z.boolean(),
  embeddingValidationError: z.string(),
  enabled: z.boolean(),
  isDefaultFor: z.array(surfaceSchema),
  microsPerCachedInputToken: countSchema,
  microsPerInputToken: countSchema,
  microsPerOutputToken: countSchema,
  modelKey: z.string().min(1),
  params: jsonObjectSchema,
  providerModelId: z.string().min(1),
  providerSlug: z.string().min(1),
  surfaces: z.array(surfaceSchema),
  version: z.number().int().positive(),
});

export const registrySchema = z.object({
  aliasesAllowed: z.boolean(),
  configs: z.array(catalogConfigSchema),
  embeddingWorkspaceCounts: z.array(
    z.object({
      count: countSchema,
      dim: z.number().int().positive(),
      modelKey: z.string(),
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
  authMode: authModeSchema,
  baseUrl: z.string(),
  contextWindowTokens: countSchema,
  displayName: z.string().min(1),
  id: z.string().min(1),
  microsPerCachedInputToken: countSchema,
  microsPerInputToken: countSchema,
  microsPerOutputToken: countSchema,
  modelKey: z.string().min(1),
  params: jsonObjectSchema,
  providerModelId: z.string().min(1),
  providerSlug: z.string().min(1),
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
  fallbacks: z.array(
    z.object({
      fromKey: z.string().min(1),
      surface: surfaceSchema,
      toKey: z.string().min(1),
    })
  ),
  revision: countSchema,
});
const apiErrorSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Health = z.infer<typeof healthSchema>;
export type UserSearchResult = z.infer<typeof userSearchSchema>[number];
export type UserDetail = z.infer<typeof userDetailSchema>;
export type CostGroup = z.infer<typeof costGroupSchema>;
export type CostRow = z.infer<typeof costRowsSchema>[number];
export type Surface = z.infer<typeof surfaceSchema>;
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;
export type Registry = z.infer<typeof registrySchema>;
export type DraftConfig = z.infer<typeof draftConfigSchema>;
export type RegistrySaveRequest = z.infer<typeof registrySaveRequestSchema>;

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
    return (
      parsed.data.message ??
      parsed.data.error ??
      `Request failed with status ${response.status}`
    );
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
    costs: (from: string, to: string, groupBy: CostGroup) => {
      const search = new URLSearchParams({ from, groupBy, to });
      return request(`/costs?${search}`, costRowsSchema);
    },
    health: () => request('/health', healthSchema),
    overview: () => request('/overview', overviewSchema),
    registry: () => request('/registry', registrySchema),
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
