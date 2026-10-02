import { delay, HttpResponse, http, type RequestHandler } from 'msw';
import { PLAN_LIMITS } from '@/features/billing/planLimits';
import { chatFixtureOptions, chatFixtures } from './chatFixtures';
import { mockChatStream } from './chatStream';
import {
  accountStatus,
  cardStats,
  discussions,
  files,
  flashcardSetFromMaterial,
  listWorkspaces,
  materials,
  quizFromMaterial,
  user,
  workspaces,
} from './db';
import { failureHandlers, failureScenarios } from './scenarioFailures';

export const authScenarios = [
  {
    id: 'auth-rejected',
    label: 'Auth: credentials rejected',
    message: 'Incorrect email or password.',
    operation: 'sign-in',
  },
  {
    id: 'auth-signup',
    label: 'Auth: email already registered',
    message: 'That email address is already registered.',
    operation: 'sign-up',
  },
  {
    id: 'auth-reset',
    label: 'Auth: reset email rejected',
    message: 'Unable to start the password reset.',
    operation: 'reset-start',
  },
  {
    id: 'auth-send-code',
    label: 'Auth: code send / resend failed',
    message: 'Unable to send a verification code. Please try again.',
    operation: 'send-code',
  },
  {
    id: 'auth-code',
    label: 'Auth: invalid / expired code',
    message: 'That code is incorrect or has expired.',
    operation: 'verify-code',
  },
  {
    id: 'auth-password',
    label: 'Auth: new password rejected',
    message: 'Choose a password that has not appeared in a data breach.',
    operation: 'new-password',
  },
  {
    id: 'auth-finalize',
    label: 'Auth: session finalize failed',
    message: 'Unable to finish signing in. Please try again.',
    operation: 'finalize',
  },
  {
    id: 'auth-sso',
    label: 'Auth: OAuth start failed',
    message: 'Unable to connect to the sign-in provider.',
    operation: 'sso',
  },
  {
    id: 'auth-callback',
    label: 'Auth: OAuth callback failed',
    message: 'Unable to finish the provider callback.',
    operation: 'sso-callback',
  },
  {
    id: 'onboarding-photo',
    label: 'Onboarding: photo upload failed',
    message: 'Unable to upload your profile photo.',
    operation: 'profile-image',
  },
  {
    id: 'onboarding-metadata',
    label: 'Onboarding: completion failed',
    message: 'Unable to finish setting up your profile.',
    operation: 'profile-metadata',
  },
] as const;

export const mockScenarioOptions = [
  { id: 'none', label: 'None (reset)' },
  ...chatFixtureOptions,
  { id: 'checkout-free', label: 'Checkout: free account + failure' },
  {
    id: 'deletion-transfer-required',
    label: 'Account deletion: transfer required',
  },
  { id: 'invite-success', label: 'Invitation accept success' },
  { id: 'chat-tool-failed', label: 'Chat tool failure' },
  { id: 'chat-undo-refused', label: 'Chat edit effect + refused undo' },
  { id: 'chat-pending-sources', label: 'Chat pending source warning' },
  { id: 'chat-source-changed', label: 'Chat source changed SSE error' },
  { id: 'chat-invalid-key', label: 'Chat invalid key SSE error' },
  ...authScenarios,
  { id: 'auth-breached', label: 'Auth: require a new password' },
  { id: 'auth-busy', label: 'Auth: pending request for 15 seconds' },
  ...failureScenarios,
  { id: 'account-grace', label: 'Grace period: dashboard' },
  { id: 'account-grace-workspace', label: 'Grace period: own workspace' },
  {
    id: 'account-storage-near-dashboard',
    label: 'Storage almost full (95%): dashboard',
  },
  {
    id: 'account-storage-near',
    label: 'Storage almost full (95%): own workspace',
  },
  { id: 'account-storage-full-dashboard', label: 'Storage full: dashboard' },
  { id: 'account-storage-full', label: 'Storage full: own workspace' },
  { id: 'account-frozen-workspace', label: 'Account frozen: own workspace' },
  {
    id: 'account-frozen-member',
    label: "Account frozen: someone else's healthy workspace",
  },
  {
    id: 'account-frozen-create',
    label: 'Account frozen: create controls disabled',
  },
  { id: 'invite-frozen', label: 'Account frozen: accept an invitation' },
  {
    id: 'note-frozen-while-editing',
    label: 'Note: account frozen while editing',
  },
  {
    id: 'source-frozen-while-editing',
    label: 'Text source: account frozen with unsaved edits',
  },
  {
    id: 'note-storage-full-while-editing',
    label: 'Note: storage full while editing',
  },
  {
    id: 'workspace-owner-near',
    label: 'Member: owner almost out of storage',
  },
  { id: 'workspace-owner-full', label: "Member: owner's storage full" },
  { id: 'workspace-owner-grace', label: "Member: owner's grace period" },
  { id: 'workspace-owner-frozen', label: "Member: owner's account frozen" },
  { id: 'account-deleted', label: 'Account deleted' },
  { id: 'account-deletion-pending', label: 'Account deletion pending' },
  { id: 'import-rejected', label: 'Cloud selection rejected' },
  { id: 'import-job-failed', label: 'Cloud import job failed' },
  { id: 'import-job-pending', label: 'Cloud import stays pending' },
  { id: 'connection-reconnecting', label: 'Events connection reconnecting' },
  { id: 'workspace-500', label: 'Workspace GET 500' },
  { id: 'workspace-401', label: 'Workspace GET 401' },
  { id: 'workspace-404', label: 'Workspace GET 404' },
  { id: 'service-503', label: 'Workspace list GET 503' },
  { id: 'workspace-timeout', label: 'Workspace GET timeout' },
  { id: 'storage-quota', label: 'Upload storage quota 403' },
  { id: 'account-suspended', label: 'Account suspended' },
  { id: 'account-over-quota', label: 'Account frozen: dashboard' },
  { id: 'workspace-flaky', label: 'Workspace: intermittent request failed' },
  { id: 'chat-sse-error', label: 'Chat SSE error frame' },
  { id: 'chat-stream-close', label: 'Chat stream closes early' },
  { id: 'chat-curate-mismatch', label: 'Chat curate flag disagrees' },
  { id: 'chat-curate-requires-editor', label: 'Chat curate needs edit access' },
  { id: 'collaboration-token', label: 'Collaboration token 503' },
  { id: 'collab-chaos', label: 'Collaboration: chaos peers join and edit' },
  { id: 'offline', label: 'Offline status preview' },
] as const;

export type MockScenarioId = (typeof mockScenarioOptions)[number]['id'];

export const LAST_SCENARIO = 'capy.scenario.last';
export const permanentScenarios: readonly string[] = [
  'file-list-forbidden',
  'account-locked',
  'workspace-401',
  'workspace-404',
  'invite-unavailable',
  'account-suspended',
  'account-deleted',
  'account-deletion-pending',
  'account-over-quota',
  'account-frozen-workspace',
  'account-frozen-member',
  'account-frozen-create',
  'invite-frozen',
  'note-frozen-while-editing',
  'source-frozen-while-editing',
  'note-storage-full-while-editing',
  'account-grace',
  'account-grace-workspace',
  'account-storage-near',
  'account-storage-near-dashboard',
  'account-storage-full',
  'account-storage-full-dashboard',
  'workspace-owner-near',
  'workspace-owner-full',
  'workspace-owner-grace',
  'workspace-owner-frozen',
];

export function humaCodedError(
  code: 'account_over_quota' | 'account_suspended' | 'storage_quota_exceeded',
  detail: string,
  value: Record<string, unknown> = {}
) {
  return {
    detail,
    errors: [{ message: code, value }],
    status: 403,
    title: 'Forbidden',
  };
}

const jsonError = (status: number, detail: string) =>
  HttpResponse.json({ detail, status }, { status });

const sseResponse = (events: unknown[]) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream',
    },
  });
};

export function getMockScenarioHandlers(
  scenario: MockScenarioId
): RequestHandler[] {
  const chatFixture = chatFixtures.find(({ id }) => id === scenario);
  if (chatFixture) return [mockChatStream(chatFixture)];
  const failure = failureScenarios.find(({ id }) => id === scenario);
  if (failure) return failureHandlers(failure);
  const auth = authScenarios.find(({ id }) => id === scenario);
  if (auth)
    return [
      http.post(`/__mock/auth/${auth.operation}`, () =>
        HttpResponse.json({ error: { message: auth.message } })
      ),
    ];
  switch (scenario) {
    case 'none':
    case 'offline':
    case 'connection-reconnecting':
      return [];
    case 'invite-success':
      return [
        http.post('/api/workspace-invites/:token/accept', () =>
          HttpResponse.json({
            createdAt: new Date().toISOString(),
            name: user.name,
            role: 'editor',
            userId: user.id,
            workspaceId: workspaces[0].id,
          })
        ),
      ];
    case 'deletion-transfer-required':
      return [
        http.get('/api/account/deletion', () =>
          HttpResponse.json({
            canDelete: false,
            graceDays: 30,
            lifecycleGeneration: 0,
            storageUsedBytes: accountStatus.storageUsedBytes,
            workspacesNeedingTransfer: [workspaces[0]],
            workspacesToDestroy: [],
          })
        ),
      ];
    case 'checkout-free':
      return [
        http.get('/api/me', () =>
          HttpResponse.json({
            ...user,
            planTier: 'free',
            subscriptionStatus: 'none',
          })
        ),
        http.get('/api/billing', () =>
          HttpResponse.json({
            cancelAtPeriodEnd: false,
            creditsLimitMicros: PLAN_LIMITS.free.creditLimitMicros,
            creditsPeriodStart: new Date().toISOString(),
            creditsReservedMicros: 0,
            creditsUsedMicros: 0,
            planTier: 'free',
            storageLimitBytes: PLAN_LIMITS.free.storageLimitBytes,
            storageReservedBytes: 0,
            storageUsedBytes: 0,
            subscriptionStatus: 'none',
          })
        ),
        http.post('/api/billing/checkout', () =>
          jsonError(503, 'Mock checkout unavailable.')
        ),
      ];
    case 'chat-tool-failed':
    case 'chat-undo-refused':
    case 'chat-pending-sources':
    case 'chat-source-changed':
    case 'chat-invalid-key':
      return [
        http.post('/api/workspaces/:id/chat/stream', ({ params }) => {
          const start = {
            conversationId: 'mock-scenario-conversation',
            messageId: crypto.randomUUID(),
            type: 'start',
          };
          if (
            scenario === 'chat-source-changed' ||
            scenario === 'chat-invalid-key'
          )
            return sseResponse([
              start,
              {
                code:
                  scenario === 'chat-source-changed'
                    ? 'source_changed'
                    : 'invalid_key',
                message: 'Mock generation failed.',
                type: 'error',
              },
            ]);
          if (scenario === 'chat-pending-sources')
            return sseResponse([
              start,
              { fileIds: ['f_2'], omitted: true, type: 'pending_sources' },
              { blockId: 'mock-answer', type: 'block_start' },
              {
                blockId: 'mock-answer',
                text: 'This answer uses the previous indexed source.',
                type: 'block_delta',
              },
              { blockId: 'mock-answer', kind: 'answer', type: 'block_end' },
              { status: 'complete', type: 'done' },
            ]);
          return sseResponse([
            start,
            {
              callId: 'mock_edit',
              detail: 'Mock source edit',
              name: 'edit_file',
              type: 'tool_start',
            },
            {
              callId: 'mock_edit',
              outcome: scenario === 'chat-tool-failed' ? 'failed' : 'succeeded',
              type: 'tool_end',
              ...(scenario === 'chat-tool-failed'
                ? { error: { code: 'source_changed', retryable: true } }
                : {
                    effects: [
                      {
                        operation: 'edited',
                        resource: {
                          id: 'f_2',
                          kind: 'file',
                          title: 'Organelles cheatsheet.md',
                          workspaceId: params.id,
                        },
                        undo: { operationId: 'mock_edit', status: 'available' },
                      },
                    ],
                  }),
            },
            { status: 'complete', type: 'done' },
          ]);
        }),
        http.post('/api/chat/edit-operations/:id/undo', () =>
          HttpResponse.json(
            { errors: [{ message: 'stale_target' }], status: 409 },
            { status: 409 }
          )
        ),
        http.post('/api/files/:id/process-changes', () =>
          jsonError(503, 'Mock processing unavailable.')
        ),
      ];
    case 'auth-breached':
      return [
        http.post('/__mock/auth/sign-in', () =>
          HttpResponse.json({ error: null, status: 'needs_new_password' })
        ),
      ];
    case 'auth-busy':
      return [
        http.post('/__mock/auth/:operation', async () => {
          await delay(15_000);
          return HttpResponse.json({ error: null });
        }),
      ];
    case 'account-grace':
    case 'account-grace-workspace':
    case 'account-deleted':
    case 'account-deletion-pending':
      return [
        // The account lifecycle rides on /me, as it does on the server.
        ...(scenario.startsWith('account-grace')
          ? [
              ownWorkspaces({
                storageOwnerState: 'over_quota_grace',
                storageOwnerUsage: 'full',
              }),
              ...viewOnlyContent('own'),
            ]
          : []),
        http.get('/api/me', () =>
          HttpResponse.json({
            ...user,
            account: {
              ...accountStatus,
              graceEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
              state: scenario.startsWith('account-grace')
                ? 'over_quota_grace'
                : scenario === 'account-deleted'
                  ? 'deleted'
                  : 'deletion_pending',
              storageUsage: 'full',
              userId: user.id,
            },
          })
        ),
      ];
    case 'account-storage-near':
    case 'account-storage-near-dashboard':
    case 'account-storage-full':
    case 'account-storage-full-dashboard':
    case 'note-storage-full-while-editing': {
      // The viewer's own account on /me, and the same level as the owner of
      // the workspaces they own.
      const storageUsage = scenario.includes('storage-full')
        ? 'full'
        : 'near_limit';
      const limit = PLAN_LIMITS.free.storageLimitBytes;
      return [
        http.get('/api/me', () =>
          HttpResponse.json({
            ...user,
            account: {
              ...accountStatus,
              planTier: 'free',
              storageLimitBytes: limit,
              storageUsage,
              storageUsedBytes:
                storageUsage === 'full' ? limit : Math.round(limit * 0.96),
              userId: user.id,
            },
          })
        ),
        ownWorkspaces({ storageOwnerUsage: storageUsage }),
        ...(storageUsage === 'full' ? viewOnlyContent('own') : []),
      ];
    }
    case 'workspace-owner-near':
    case 'workspace-owner-full':
    case 'workspace-owner-grace':
    case 'workspace-owner-frozen': {
      // The viewer as an editor member of someone else's workspace.
      const frozen = scenario === 'workspace-owner-frozen';
      const near = scenario === 'workspace-owner-near';
      return [
        http.get('/api/workspaces/:id', ({ params }) => {
          const workspace = workspaces.find((row) => row.id === params.id);
          if (!workspace) return new HttpResponse(null, { status: 404 });
          return HttpResponse.json({
            ...workspace,
            capabilities: {
              ...workspace.capabilities,
              canEdit: !frozen,
              canEditContent: near,
              canManageMembers: false,
            },
            isOwner: false,
            role: 'editor',
            storageOwnerState: frozen
              ? 'over_quota_frozen'
              : scenario === 'workspace-owner-grace'
                ? 'over_quota_grace'
                : 'active',
            storageOwnerUsage:
              scenario === 'workspace-owner-near' ? 'near_limit' : 'full',
          });
        }),
        ...(frozen
          ? [...frozenMaterialHandlers(), frozenWrites('owner')]
          : near
            ? []
            : viewOnlyContent('member')),
      ];
    }
    case 'import-rejected':
      return [
        http.post('/api/workspaces/:id/sources/import-inspect', () =>
          HttpResponse.json({
            items: [],
            rejected: [
              {
                code: 'provider_file_unavailable',
                fileId: 'mock_drive_file',
                name: 'Unavailable cloud file',
              },
              {
                code: 'file_too_large',
                fileId: 'mock_drive_large',
                name: 'Oversized cloud file',
              },
              {
                code: 'folder_empty',
                fileId: 'mock_drive_folder',
                name: 'Empty folder',
              },
            ],
          })
        ),
      ];
    case 'import-job-failed':
    case 'import-job-pending':
      return [
        http.get('/api/workspaces/:id/sources/imports/:jobId', ({ params }) =>
          HttpResponse.json({
            jobId: params.jobId,
            name: 'Mock cloud document',
            status: scenario === 'import-job-failed' ? 'failed' : 'pending',
            ...(scenario === 'import-job-failed'
              ? { errorCode: 'provider_file_unavailable' }
              : {}),
          })
        ),
      ];
    case 'workspace-500':
      return [
        http.get('/api/workspaces/:id', () =>
          jsonError(500, 'The mock workspace request failed.')
        ),
      ];
    case 'workspace-401':
      return [
        http.get('/api/workspaces/:id', () =>
          jsonError(401, 'Authentication is required.')
        ),
      ];
    case 'workspace-404':
      return [
        http.get('/api/workspaces/:id', () =>
          jsonError(404, 'Workspace not found.')
        ),
      ];
    case 'service-503':
      return [
        http.get('/api/workspaces', () =>
          jsonError(503, 'The workspace service is unavailable.')
        ),
      ];
    case 'workspace-timeout':
      return [
        http.get('/api/workspaces/:id', async () => {
          await delay('infinite');
          return jsonError(504, 'The mock workspace request timed out.');
        }),
      ];
    case 'storage-quota':
      return [
        http.post('/api/workspaces/:id/sources/import', () =>
          HttpResponse.json(
            humaCodedError(
              'storage_quota_exceeded',
              'The import exceeds the storage allowance.'
            ),
            { status: 403 }
          )
        ),
        http.post('/api/workspaces/:id/sources', () =>
          HttpResponse.json(
            humaCodedError(
              'storage_quota_exceeded',
              'The upload exceeds the storage allowance.',
              { limitBytes: 1024, usedBytes: 1024 }
            ),
            { status: 403 }
          )
        ),
        http.post('/api/workspaces/:id/materials', () =>
          HttpResponse.json(
            humaCodedError(
              'storage_quota_exceeded',
              'The mutation exceeds the storage allowance.',
              { limitBytes: 1024, usedBytes: 1024 }
            ),
            { status: 403 }
          )
        ),
      ];
    case 'account-suspended':
      return [
        // The auth middleware refuses every route for a suspended account.
        http.get('/api/me', () =>
          HttpResponse.json(
            humaCodedError(
              'account_suspended',
              'This mock account is suspended.'
            ),
            { status: 403 }
          )
        ),
      ];
    case 'account-frozen-member':
      // The viewer's own frozen account in a healthy owner's workspace: read
      // only there too.
      return [
        http.get('/api/workspaces/:id', ({ params }) => {
          const workspace = workspaces.find((row) => row.id === params.id);
          if (!workspace) return new HttpResponse(null, { status: 404 });
          const readOnly = readOnlyWorkspace(workspace);
          return HttpResponse.json({
            ...readOnly,
            capabilities: { ...readOnly.capabilities, canManageMembers: false },
            isOwner: false,
            role: 'editor',
            storageOwnerState: 'active',
            storageOwnerUsage: 'ok',
          });
        }),
        ...frozenAccount(),
      ];
    case 'account-over-quota':
    case 'account-frozen-workspace':
    case 'account-frozen-create':
    case 'invite-frozen':
    case 'note-frozen-while-editing':
    case 'source-frozen-while-editing':
      return frozenAccount();
    case 'workspace-flaky': {
      let requestCount = 0;
      return [
        http.get('/api/workspaces/:id', () => {
          requestCount += 1;
          if (requestCount % 3 === 1) {
            return jsonError(503, 'Mock intermittent workspace failure.');
          }
        }),
      ];
    }
    case 'chat-sse-error':
      return [
        http.post('/api/workspaces/:id/chat/stream', () =>
          sseResponse([
            {
              conversationId: 'mock-error-conversation',
              messageId: 'mock-error-message',
              type: 'start',
            },
            { message: 'Mock chat generation failed.', type: 'error' },
          ])
        ),
      ];
    case 'chat-stream-close':
      return [
        http.post('/api/workspaces/:id/chat/stream', () =>
          sseResponse([
            {
              conversationId: 'mock-closed-conversation',
              messageId: 'mock-closed-message',
              type: 'start',
            },
            { blockId: 'mock-answer', type: 'block_start' },
            {
              blockId: 'mock-answer',
              text: 'Partial mock response ',
              type: 'block_delta',
            },
          ])
        ),
      ];
    // A chat's mode is fixed when it is created and only an editor may curate,
    // so both refusals arrive before the stream opens.
    case 'chat-curate-mismatch':
    case 'chat-curate-requires-editor':
      return [
        http.post('/api/workspaces/:id/chat/stream', () =>
          HttpResponse.json(
            {
              code:
                scenario === 'chat-curate-mismatch'
                  ? 'curate_mismatch'
                  : 'curate_requires_editor',
              message: 'Mock curate refusal.',
            },
            { status: 400 }
          )
        ),
      ];
    case 'collaboration-token':
      return [
        http.post('/api/materials/:id/collaboration-token', () =>
          jsonError(503, 'The collaboration service is unavailable.')
        ),
      ];
  }
  return [];
}

/** A frozen account's materials, as the server returns them: read-only. */
function frozenMaterialHandlers(): RequestHandler[] {
  return [
    http.get('/api/materials/:id', ({ params }) => {
      const material = materials.find((row) => row.id === params.id);
      if (!material) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({
        ...material,
        capabilities: {
          ...material.capabilities,
          canEdit: false,
          canEditContent: false,
        },
      });
    }),
  ];
}

/** A frozen requester as the server answers them: its own state on /me,
 * read-only workspaces (no Clone) and materials, and every write refused. */
function frozenAccount(): RequestHandler[] {
  return [
    http.get('/api/me', () =>
      HttpResponse.json({
        ...user,
        account: {
          planTier: 'free',
          state: 'over_quota_frozen',
          storageLimitBytes: 1024,
          storageUsage: 'full',
          storageUsedBytes: 2048,
          userId: user.id,
        },
      })
    ),
    http.get('/api/workspaces', ({ request }) =>
      HttpResponse.json(
        listWorkspaces(new URL(request.url)).map(readOnlyWorkspace)
      )
    ),
    http.get('/api/workspaces/:id', ({ params }) => {
      const workspace = workspaces.find((row) => row.id === params.id);
      if (!workspace) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({
        ...readOnlyWorkspace(workspace),
        ...(workspace.isOwner && {
          storageOwnerState: 'over_quota_frozen',
          storageOwnerUsage: 'full',
        }),
      });
    }),
    ...frozenMaterialHandlers(),
    frozenWrites('account'),
  ];
}

const readOnlyWorkspace = (workspace: (typeof workspaces)[number]) => ({
  ...workspace,
  canClone: false,
  capabilities: {
    ...workspace.capabilities,
    canEdit: false,
    canEditContent: false,
  },
});

// What a frozen account keeps: reading, deleting whole items, narrowing
// exposure, transfer, chat, quiz attempts, notifications, billing, account
// settings and the question bank. Deleting one flashcard or PDF mark is an
// edit.
const keptWhenFrozen = [
  /^DELETE \/api\/(?!files\/[^/]+\/annotations\/|flashcards\/cards\/)/,
  /^PATCH \/api\/[a-z]+\/[^/]+\/sharing$/,
  /^POST \/api\/workspaces\/[^/]+\/(transfer|chat\/stream)$/,
  /^POST \/api\/(materials|files)\/[^/]+\/collaboration-token$/,
  /^POST \/api\/quizzes\/[^/]+\/(attempts|grade)$/,
  /^POST \/api\/(notifications|billing|account)\//,
  /^(PATCH|PUT|DELETE) \/api\/(me|notification-prefs)(\/|$)/,
  /^[A-Z]+ \/api\/bank\//,
];
// A frozen owner's content (for a healthy member only these writes fail).
const ownerContent =
  /^\/api\/(workspaces\/[^/]+|materials\/[^/]+|files|quizzes\/[^/]+|flashcards\/[^/]+|chapters|comments|discussions|trash)(\/|$)/;

/** The server's `account_over_quota` for every write it refuses: anything a
 * frozen `account` does apart from what it keeps, or writes into a frozen
 * `owner`'s content. A curate thread counts; an ordinary chat thread does not. */
function frozenWrites(scope: 'account' | 'owner'): RequestHandler {
  return http.all('/api/*', async ({ request }) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const path = new URL(request.url).pathname;
    if (path.endsWith('/conversations')) {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { curate?: boolean } | null;
      if (!body?.curate) return;
    } else if (
      keptWhenFrozen.some((rule) => rule.test(`${request.method} ${path}`)) ||
      (scope === 'owner' && !ownerContent.test(path))
    )
      return;
    return HttpResponse.json(
      humaCodedError('account_over_quota', 'This account is frozen.'),
      { status: 403 }
    );
  });
}

/** The viewer's own storage status on the workspaces they own; at the limit
 * their content is view-only. */
function ownWorkspaces(owner: {
  storageOwnerState?: 'over_quota_grace';
  storageOwnerUsage: 'full' | 'near_limit';
}) {
  return http.get('/api/workspaces/:id', ({ params }) => {
    const workspace = workspaces.find((row) => row.id === params.id);
    if (!workspace) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json(
      workspace.isOwner
        ? {
            ...workspace,
            ...owner,
            capabilities: {
              ...workspace.capabilities,
              canEditContent: owner.storageOwnerUsage !== 'full',
            },
          }
        : workspace
    );
  });
}

// What the server refuses with the storage code while the owner is at or over
// its limit, with the workspace that pays for the target (null: standalone):
// content edits, comments and PDF marks. Organizing (rename, move, reorder,
// trash), study progress and deleting a comment stay open.
const materialWorkspace = (id: string | undefined) =>
  materials.find((row) => row.id === id)?.workspaceId || null;
const contentWrites: [RegExp, (id: string) => string | null][] = [
  [/^POST \/api\/materials\/([^/]+)\/discussions$/, materialWorkspace],
  [
    /^POST \/api\/discussions\/([^/]+)\/comments$/,
    (id) =>
      materialWorkspace(discussions.find((row) => row.id === id)?.materialId),
  ],
  [
    /^PATCH \/api\/comments\/([^/]+)$/,
    (id) =>
      materialWorkspace(
        discussions.find((row) => row.comments.some((c) => c.id === id))
          ?.materialId
      ),
  ],
  [
    /^(?:POST|PATCH|DELETE) \/api\/files\/([^/]+)\/annotations(?:\/|$)/,
    (id) => files.find((row) => row.id === id)?.workspaceId || null,
  ],
  [
    /^PATCH \/api\/(?:quizzes|flashcards)\/([^/]+)\/content$/,
    materialWorkspace,
  ],
  [/^POST \/api\/flashcards\/([^/]+)\/cards$/, materialWorkspace],
  [
    /^POST \/api\/materials\/([^/]+)\/editor-assets\/uploads$/,
    materialWorkspace,
  ],
  [
    /^(?:PATCH \/api\/flashcards\/cards\/([^/]+)\/content|DELETE \/api\/flashcards\/cards\/([^/]+))$/,
    (id) => materialWorkspace(cardStats[id]?.materialId),
  ],
];

/** An owner at or over its storage limit (full, grace included) as the server
 * answers: what it pays for is view-only while organizing works, and creating
 * or uploading into it fails the quota. `own` is the viewer's own workspaces,
 * standalone items and clones (charged to the viewer, who then gets the
 * numbers), `member` every workspace (the viewer as a member of the owner's,
 * who gets the code alone). */
function viewOnlyContent(scope: 'own' | 'member'): RequestHandler[] {
  const limit = PLAN_LIMITS.free.storageLimitBytes;
  const detail =
    scope === 'own'
      ? {
          ownerUserId: user.id,
          storageLimitBytes: limit,
          storageUsedBytes: limit,
        }
      : {};
  const paysFor = (workspaceId: string | null | undefined) =>
    scope === 'member'
      ? !!workspaceId
      : !workspaceId ||
        !!workspaces.find((row) => row.id === workspaceId)?.isOwner;
  const find = (id: unknown, kind?: string) =>
    materials.find((row) => row.id === id && (!kind || row.kind === kind));
  return [
    http.get('/api/materials/:id', ({ params }) => {
      const material = find(params.id);
      if (!material || !paysFor(material.workspaceId)) return;
      return HttpResponse.json({
        ...material,
        capabilities: { ...material.capabilities, canEditContent: false },
      });
    }),
    http.get('/api/quizzes/:id', ({ params }) => {
      const material = find(params.id, 'quiz');
      if (!material || !paysFor(material.workspaceId)) return;
      return HttpResponse.json({
        ...quizFromMaterial(material),
        canEditContent: false,
      });
    }),
    http.get('/api/flashcards/:id', ({ params }) => {
      const material = find(params.id, 'flashcards');
      if (!material || !paysFor(material.workspaceId)) return;
      return HttpResponse.json({
        ...flashcardSetFromMaterial(material),
        canEditContent: false,
      });
    }),
    http.all('/api/*', async ({ request }) => {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      const into =
        /^POST \/api\/workspaces\/([^/]+)\/(materials|sources|sources\/import|generate)$/.exec(
          route
        )?.[1];
      const embedded = /^POST \/api\/materials\/([^/]+)\/embedded$/.exec(
        route
      )?.[1];
      const standalone = /^POST \/api\/(materials|quizzes|flashcards)$/.test(
        route
      );
      const content = contentWrites
        .map(([rule, target]) => {
          const match = rule.exec(route);
          return match && { workspaceId: target(match[1] ?? match[2]) };
        })
        .find(Boolean);
      const refused =
        (!!content && paysFor(content.workspaceId)) ||
        (into !== undefined && paysFor(into)) ||
        (embedded !== undefined && paysFor(find(embedded)?.workspaceId)) ||
        (standalone &&
          paysFor(
            (
              (await request
                .clone()
                .json()
                .catch(() => null)) as { workspaceId?: string } | null
            )?.workspaceId
          )) ||
        (scope === 'own' &&
          /^POST \/api\/(workspaces|quizzes|flashcards|materials)\/[^/]+\/clone$/.test(
            route
          ));
      if (!refused) return;
      return HttpResponse.json(
        humaCodedError(
          'storage_quota_exceeded',
          'The storage limit is reached.',
          detail
        ),
        { status: 403 }
      );
    }),
  ];
}
