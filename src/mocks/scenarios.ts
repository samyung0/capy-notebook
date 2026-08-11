import { delay, HttpResponse, http, type RequestHandler } from 'msw';

export const mockScenarioOptions = [
  { id: 'none', label: 'None (reset)' },
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
  { id: 'ingest-failed', label: 'Ingest failed event' },
  { id: 'collaboration-token', label: 'Collaboration token 503' },
  { id: 'offline', label: 'Browser offline' },
] as const;

export type MockScenarioId = (typeof mockScenarioOptions)[number]['id'];

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
  switch (scenario) {
    case 'none':
    case 'offline':
      return [];
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
            { text: 'Partial mock response ', type: 'token' },
          ])
        ),
      ];
    case 'ingest-failed':
      return [
        http.get('/api/workspaces/:id/ingest-events', () =>
          sseResponse([
            {
              fileId: 'f_mock_failed',
              pct: 42,
              status: 'failed',
            },
          ])
        ),
      ];
    case 'collaboration-token':
      return [
        http.post('/api/materials/:id/collaboration-token', () =>
          jsonError(503, 'The collaboration service is unavailable.')
        ),
      ];
  }
}
