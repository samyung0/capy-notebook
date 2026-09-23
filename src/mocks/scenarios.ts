import { delay, HttpResponse, http, type RequestHandler } from 'msw';
import { PLAN_LIMITS } from '@/features/billing/planLimits';
import { chatFixtureOptions, chatFixtures } from './chatFixtures';
import { mockChatStream } from './chatStream';
import { accountStatus, user, workspaces } from './db';
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
  { id: 'account-grace', label: 'Account over quota: grace period' },
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
  { id: 'account-over-quota', label: 'Account over quota' },
  { id: 'workspace-flaky', label: 'Workspace GET flaky (1 in 3)' },
  { id: 'chat-sse-error', label: 'Chat SSE error frame' },
  { id: 'chat-stream-close', label: 'Chat stream closes early' },
  { id: 'chat-curate-mismatch', label: 'Chat curate flag disagrees' },
  { id: 'chat-curate-requires-editor', label: 'Chat curate needs edit access' },
  { id: 'collaboration-token', label: 'Collaboration token 503' },
  { id: 'collab-chaos', label: 'Collaboration: chaos peers join and edit' },
  { id: 'offline', label: 'Browser offline' },
] as const;

export type MockScenarioId = (typeof mockScenarioOptions)[number]['id'];

export function storedMockScenario(): MockScenarioId {
  const saved = sessionStorage.getItem('capy.mockScenario');
  return mockScenarioOptions.find(({ id }) => id === saved)?.id ?? 'none';
}

export function storeMockScenario(scenario: MockScenarioId) {
  sessionStorage.setItem('capy.mockScenario', scenario);
}

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
    case 'account-deleted':
    case 'account-deletion-pending':
      return [
        http.get('/api/account/status', () =>
          HttpResponse.json({
            ...accountStatus,
            graceEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            state:
              scenario === 'account-grace'
                ? 'over_quota_grace'
                : scenario === 'account-deleted'
                  ? 'deleted'
                  : 'deletion_pending',
          })
        ),
      ];
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
        http.get('/api/account/status', () =>
          HttpResponse.json(
            humaCodedError(
              'account_suspended',
              'This mock account is suspended.'
            ),
            { status: 403 }
          )
        ),
      ];
    case 'account-over-quota':
      return [
        http.get('/api/account/status', () =>
          HttpResponse.json({
            planTier: 'free',
            state: 'over_quota_frozen',
            storageLimitBytes: 1024,
            storageUsedBytes: 2048,
            userId: 'u_mock',
          })
        ),
        http.post('/api/workspaces/:id/materials', () =>
          HttpResponse.json(
            humaCodedError(
              'account_over_quota',
              'This mock account is over quota.'
            ),
            { status: 403 }
          )
        ),
      ];
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
