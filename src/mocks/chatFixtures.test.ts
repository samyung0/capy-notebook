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
import { chartFigure, plotFigure } from '@/features/workspace/chat/answer';
import {
  parseMarkdownAnswer,
  type Segment,
  unfinished,
} from '@/features/workspace/chat/markdownSegments';
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

/** Chart and plot fences the block schema refuses, tabs included. */
const refused = (segments: Segment[]): number =>
  segments
    .map((segment) => {
      if (segment.type === 'tabs')
        return refused(segment.tabs.flatMap((tab) => tab.segments));
      if (segment.type !== 'figure' || !segment.closed) return 0;
      if (segment.lang === 'chart') return chartFigure(segment.body) ? 0 : 1;
      if (segment.lang === 'plot') return plotFigure(segment.body) ? 0 : 1;
      return 0;
    })
    .reduce((sum, count) => sum + count, 0);

it('parses each design fixture and keeps only the intentional gaps', () => {
  const gaps = new Set(['chat-answer-partial', 'chat-answer-unusable']);
  for (const fixture of chatFixtures) {
    const segments = parseMarkdownAnswer(fixture.content);
    expect(unfinished(segments), fixture.id).toBe(gaps.has(fixture.id));
    expect(refused(segments), fixture.id).toBe(
      fixture.id === 'chat-answer-invalid-chart' ? 1 : 0
    );
  }
  const questions = chatFixtures.find(
    ({ id }) => id === 'chat-answer-questions'
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
    if (fixture.id === 'chat-answer-overview') {
      expect(saved?.citations?.map(({ fileId }) => fileId)).toEqual([
        'f_1',
        'f_2',
      ]);
    }
    if (fixture.id === 'chat-answer-office') {
      expect(saved?.citations).toMatchObject([
        {
          fileId: 'bio-office-docx',
          fileName: 'exchange-plan.docx',
          n: 1,
          snippet: '工程學會亦因此已經三年沒有舉辦交流學習團',
        },
      ]);
    }
    if (fixture.id === 'chat-answer-flagged') {
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
  ['chat-answer-layouts', undefined],
  ['chat-answer-partial', undefined],
  ['chat-answer-flagged', 'response_flagged'],
  ['chat-answer-empty', 'invalid_answer'],
  ['chat-answer-interrupted', 'agent_failed'],
] as const)(
  'streams %s and persists its outcome',
  async (scenario, errorCode) => {
    server.use(...getMockScenarioHandlers(scenario));
    let start: StreamStart | undefined;
    // The answer's text; the mock turn's narration block is left out.
    const blocks = new Map<string, string>();
    const narration = new Set<string>();
    const onError = vi.fn();
    const onDone = vi.fn();
    const onToolEnd = vi.fn();
    await streamChat(
      'ws_bio',
      { text: 'Preview "quotes" and\nnewlines', workspaceOnly: false },
      {
        onBlockDelta: (id, text) => {
          blocks.set(id, (blocks.get(id) ?? '') + text);
        },
        onBlockEnd: (id, kind) => {
          if (kind === 'narration') narration.add(id);
        },
        onDone,
        onError,
        onStart: (event) => {
          start = event;
        },
        onToolEnd,
      }
    );
    const streamed = [...blocks]
      .filter(([id]) => !narration.has(id))
      .map(([, text]) => text)
      .join('');
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
