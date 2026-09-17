import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { streamChat } from '@/api/chatStream';
import {
  getMockScenarioHandlers,
  humaCodedError,
  mockScenarioOptions,
} from './scenarios';

const server = setupServer(
  http.post('*/__mock/auth/:operation', () =>
    HttpResponse.json({ error: null })
  )
);
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://localhost/'));
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

describe('mock user scenarios', () => {
  it('keeps scenario identifiers unique and maps network scenarios to handlers', () => {
    const ids = mockScenarioOptions.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(getMockScenarioHandlers('none')).toEqual([]);
    expect(getMockScenarioHandlers('offline')).toEqual([]);
    for (const id of ids) {
      if (id === 'none' || id === 'offline' || id === 'connection-reconnecting')
        continue;
      expect(getMockScenarioHandlers(id).length).toBeGreaterThan(0);
    }
  });

  it('fails the selected auth step while allowing earlier steps and clearing the override', async () => {
    server.resetHandlers(
      http.post('*/__mock/auth/:operation', () =>
        HttpResponse.json({ error: null })
      )
    );
    server.use(...getMockScenarioHandlers('auth-code'));
    const post = (step: string) =>
      fetch(`http://localhost/__mock/auth/${step}`, { method: 'POST' }).then(
        (response) => response.json()
      );
    expect(await post('sign-up')).toEqual({ error: null });
    expect(await post('verify-code')).toEqual({
      error: { message: 'That code is incorrect or has expired.' },
    });
    server.resetHandlers();
    expect(await post('verify-code')).toEqual({ error: null });
  });

  it('uses the real upload, cloud-job and flashcard study endpoints', async () => {
    server.use(...getMockScenarioHandlers('ingest-slots'));
    const upload = await fetch('http://localhost/api/workspaces/ws_1/sources', {
      method: 'POST',
    });
    expect(upload.status).toBe(429);
    expect(await upload.json()).toMatchObject({
      errors: [{ message: 'too_many_ingest_leases' }],
    });
    server.use(...getMockScenarioHandlers('import-job-failed'));
    expect(
      await (
        await fetch(
          'http://localhost/api/workspaces/ws_1/sources/imports/job_1'
        )
      ).json()
    ).toMatchObject({
      errorCode: 'provider_file_unavailable',
      jobId: 'job_1',
      status: 'failed',
    });
    server.use(...getMockScenarioHandlers('flashcard-progress'));
    expect(
      (
        await fetch(
          'http://localhost/api/flashcards/cards/card_1/study-state',
          { method: 'PATCH' }
        )
      ).status
    ).toBe(500);
  });

  it('delivers pending-source warnings, answer blocks and undo effects through the real chat parser', async () => {
    const interceptedFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      interceptedFetch(
        typeof input === 'string' ? new URL(input, 'http://localhost') : input,
        init
      )
    );
    const onPendingSources = vi.fn();
    const onBlockDelta = vi.fn();
    const onToolEnd = vi.fn();
    const onError = vi.fn();
    server.use(...getMockScenarioHandlers('chat-pending-sources'));
    await streamChat(
      'ws_bio',
      { curate: false, text: 'Preview' },
      { onBlockDelta, onError, onPendingSources }
    );
    expect(onPendingSources).toHaveBeenCalledWith({
      fileIds: ['f_2'],
      omitted: true,
    });
    expect(onBlockDelta).toHaveBeenCalledWith(
      'mock-answer',
      'This answer uses the previous indexed source.'
    );
    server.use(...getMockScenarioHandlers('chat-undo-refused'));
    await streamChat(
      'ws_bio',
      { curate: false, text: 'Preview' },
      { onError, onToolEnd }
    );
    expect(onToolEnd).toHaveBeenCalledWith(
      'mock_edit',
      expect.objectContaining({
        effects: [
          expect.objectContaining({
            undo: { operationId: 'mock_edit', status: 'available' },
          }),
        ],
        outcome: 'succeeded',
      })
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('turns each curate refusal into its own chat message', async () => {
    for (const [scenario, message] of [
      [
        'chat-curate-mismatch',
        "This chat's mode was set when it started. Start a new chat to change it.",
      ],
      [
        'chat-curate-requires-editor',
        'Curating from the library needs edit access to this workspace.',
      ],
    ] as const) {
      const onError = vi.fn();
      server.use(...getMockScenarioHandlers(scenario));
      await streamChat(
        'ws_bio',
        { curate: true, text: 'Teach me' },
        { onError }
      );
      expect(onError).toHaveBeenCalledWith(message);
    }
  });

  it('builds the Huma coded envelope consumed by the API client', () => {
    expect(
      humaCodedError('storage_quota_exceeded', 'Storage is full.', {
        limitBytes: 10,
        usedBytes: 10,
      })
    ).toEqual({
      detail: 'Storage is full.',
      errors: [
        {
          message: 'storage_quota_exceeded',
          value: { limitBytes: 10, usedBytes: 10 },
        },
      ],
      status: 403,
      title: 'Forbidden',
    });
  });
});
