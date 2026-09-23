import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { type StreamStart, streamChat } from '@/api/chatStream';
import type { WireMessage } from '@/api/types';
import { inspectAnswer, isLangAnswer } from '@/features/workspace/chat/answer';
import { parseAnswer } from '@/features/workspace/chat/library';
import { extractQuestions } from '@/features/workspace/chat/questions';
import { chatFixtures } from './chatFixtures';
import { chatMessages, conversations } from './db';
import { handlers } from './handlers';
import { getMockScenarioHandlers } from './scenarios';

vi.mock('msw', async (importOriginal) => ({
  ...(await importOriginal<typeof import('msw')>()),
  delay: vi.fn().mockResolvedValue(undefined),
}));

const server = setupServer(...handlers);
const initialConversations = conversations.length;
const initialMessages = chatMessages.length;

beforeAll(() => {
  vi.stubGlobal('location', new URL('http://localhost/'));
  server.listen({ onUnhandledRequest: 'error' });
});
beforeEach(() => {
  const interceptedFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    interceptedFetch(
      typeof input === 'string' ? new URL(input, 'http://localhost') : input,
      init
    )
  );
});
afterEach(() => {
  server.resetHandlers();
  conversations.splice(initialConversations);
  chatMessages.splice(initialMessages);
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

it('renders each design fixture and keeps only the intentional local recovery failures', () => {
  const gaps = new Set([
    'chat-openui-partial',
    'chat-openui-invalid-chart',
    'chat-openui-unusable',
  ]);
  for (const fixture of chatFixtures) {
    if (!isLangAnswer(fixture.content)) continue;
    const result = parseAnswer(fixture.content);
    expect(inspectAnswer(result).gap, fixture.id).toBe(gaps.has(fixture.id));
    if (!gaps.has(fixture.id)) {
      expect(result?.root, fixture.id).toBeTruthy();
      expect(result?.meta.errors, fixture.id).toEqual([]);
    }
  }
  const questions = chatFixtures.find(
    ({ id }) => id === 'chat-openui-questions'
  )!;
  expect(extractQuestions(questions.content)).toHaveLength(3);
  expect(extractQuestions(questions.content)[2].choices).toEqual([]);
});

it('seeds every preview in Biology chat history, including cleared flagged responses', () => {
  for (const fixture of chatFixtures) {
    const conversation = conversations.find(
      ({ id }) => id === `conv_${fixture.id}`
    );
    expect(conversation).toMatchObject({
      title: fixture.label,
      workspaceId: 'ws_bio',
    });
    const saved = chatMessages.find(
      (message) =>
        message.conversationId === conversation!.id &&
        message.role === 'assistant'
    );
    expect(saved).toBeDefined();
    if (fixture.id === 'chat-openui-overview') {
      expect(saved?.citations?.map(({ fileId }) => fileId)).toEqual([
        'f_1',
        'f_2',
      ]);
    }
    if (fixture.id === 'chat-openui-flagged') {
      expect(saved).toMatchObject({
        citations: [],
        content: '',
        errorCode: 'response_flagged',
        status: 'error',
      });
      expect(saved?.activity).toHaveLength(1);
    }
  }
});

it.each([
  ['chat-openui-layouts', undefined],
  ['chat-openui-partial', undefined],
  ['chat-openui-flagged', 'response_flagged'],
  ['chat-openui-empty', 'invalid_answer'],
  ['chat-openui-interrupted', 'agent_failed'],
] as const)(
  'streams %s through the real parser and persists its outcome',
  async (scenario, errorCode) => {
    server.use(...getMockScenarioHandlers(scenario));
    let start: StreamStart | undefined;
    let streamed = '';
    const onError = vi.fn();
    const onDone = vi.fn();
    const onToolEnd = vi.fn();
    await streamChat(
      'ws_bio',
      { curate: false, text: 'Preview "quotes" and\nnewlines' },
      {
        onBlockDelta: (_id, text) => {
          streamed += text;
        },
        onDone,
        onError,
        onStart: (event) => {
          start = event;
        },
        onToolEnd,
      }
    );
    expect(onToolEnd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'succeeded' })
    );
    const saved = (await (
      await fetch(
        `http://localhost/api/conversations/${start!.conversationId}/messages`
      )
    ).json()) as WireMessage[];
    expect(saved[0].content).toBe('Preview "quotes" and\nnewlines');
    const assistant = saved[1];
    expect(assistant.id).toBe(start!.messageId);
    expect(assistant.errorCode).toBe(errorCode);
    expect(assistant.status).toBe(errorCode ? 'error' : 'complete');
    if (errorCode) {
      expect(onError).toHaveBeenCalledOnce();
      expect(onDone).not.toHaveBeenCalled();
      if (errorCode === 'response_flagged') {
        expect(onError).toHaveBeenCalledWith(
          'Response flagged due to safety concern',
          errorCode
        );
        expect(streamed).not.toBe('');
        expect(assistant).toMatchObject({ citations: [], content: '' });
      } else {
        expect(assistant.content).toBe(streamed);
      }
    } else {
      expect(onError).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'complete' })
      );
      expect(assistant.content).toBe(streamed);
    }
  }
);
