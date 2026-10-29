import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatStreamHandlers } from '@/api/chatStream';
import type { ChatMessage, ResourceEffect } from '@/api/types';

// linkedom's document before react-dom/client loads, which reads it once.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
vi.mock('@/api/auth', () => ({
  authHeaders: async () => ({}),
  USE_MSW: false,
}));
vi.mock('@/lib/analytics', () => ({ track: () => undefined }));

type Connection = (
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
) => Promise<void>;
// Each connection the hook opens takes the next script.
const connections: Connection[] = [];
const resumeChat = vi.fn(
  (
    _conversationId: string,
    _messageId: string,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal
  ) => (connections.shift() as Connection)(handlers, signal)
);
const streamChat = vi.fn(
  (
    _workspaceId: string,
    _body: unknown,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal
  ) => (connections.shift() as Connection)(handlers, signal)
);
vi.mock('@/api/chatStream', async (original) => ({
  ...(await original<typeof import('@/api/chatStream')>()),
  resumeChat,
  streamChat,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('@/api/client');
const { seedsAgain, useChatStream } = await import('./useChatStream');

afterEach(() => {
  vi.restoreAllMocks();
  resumeChat.mockClear();
  streamChat.mockClear();
  connections.length = 0;
});

const start = { conversationId: 'c_1', messageId: 'm_1' };
const until = (signal?: AbortSignal) =>
  new Promise<void>((resolve) =>
    signal?.addEventListener('abort', () => resolve())
  );
/** A connection that replays the turn's start and `text` of its answer,
 * then stays open. */
const replaying =
  (text: string): Connection =>
  (handlers, signal) => {
    handlers.onStart?.(start);
    handlers.onPhase?.('answering');
    handlers.onBlockStart?.('b_1');
    handlers.onBlockDelta?.('b_1', text);
    return until(signal);
  };

const history: ChatMessage[] = [
  {
    content: 'What do mitochondria do?',
    id: 'm_0',
    role: 'user',
    status: 'complete',
  },
  {
    activity: [{ id: 'n_0', kind: 'narration', text: 'saved checkpoint' }],
    content: '',
    id: 'm_1',
    role: 'assistant',
    status: 'streaming',
  },
];

async function mount() {
  let chat!: ReturnType<typeof useChatStream>;
  function Probe() {
    chat = useChatStream('ws_1');
    return null;
  }
  const client = new QueryClient();
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
  return {
    answer: () => chat.messages.at(-1),
    chat: () => chat,
    async unmount() {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

// Epo 2026-10-27, T19: a conversation whose history ends in a running turn
// follows it again, live, with Stop.
it('follows a running turn again and stops it', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(undefined);
  connections.push(replaying('Mitochondria turn food'));
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', history, true));

  expect(resumeChat).toHaveBeenCalledWith(
    'c_1',
    'm_1',
    expect.anything(),
    expect.anything()
  );
  expect(view.chat().streaming).toBe(true);
  expect(view.answer()).toMatchObject({
    activity: [],
    currentBlockText: 'Mitochondria turn food',
  });

  await act(async () => view.chat().stop());
  await act(() =>
    vi.waitFor(() => expect(view.answer()?.status).toBe('aborted'))
  );
  expect(post).toHaveBeenCalledWith('/conversations/c_1/messages/m_1/stop');
  expect(view.chat().streaming).toBe(false);
  await view.unmount();
});

it('reconnects after a drop and rebuilds the answer from the replay', async () => {
  connections.push(
    async (handlers) => {
      handlers.onStart?.(start);
      handlers.onBlockStart?.('b_1');
      handlers.onBlockDelta?.('b_1', 'Mitochondria');
      handlers.onDrop?.(new TypeError('network error'));
    },
    async (handlers) => {
      handlers.onStart?.(start);
      handlers.onBlockStart?.('b_1');
      handlers.onBlockDelta?.('b_1', 'Mitochondria turn food into energy');
      handlers.onBlockEnd?.('b_1', 'answer');
      handlers.onDone?.({ status: 'complete' });
    }
  );
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', history, true));
  await act(() =>
    vi.waitFor(() => expect(view.answer()?.status).toBe('complete'))
  );

  expect(resumeChat).toHaveBeenCalledTimes(2);
  expect(view.answer()?.content).toBe('Mitochondria turn food into energy');
  expect(view.chat().streaming).toBe(false);
  await view.unmount();
});

it('shows the saved row of a turn that ended before it was followed', async () => {
  vi.spyOn(api, 'get').mockResolvedValue([
    history[0],
    { ...history[1], content: 'Saved answer', status: 'complete' },
  ]);
  connections.push(async (handlers) => handlers.onGone?.());
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', history, true));
  await act(() =>
    vi.waitFor(() => expect(view.answer()?.status).toBe('complete'))
  );
  expect(view.answer()?.content).toBe('Saved answer');
  await view.unmount();
});

it('fails a send whose connection drops before the turn is named', async () => {
  connections.push(async (handlers) =>
    handlers.onDrop?.(new TypeError('Failed to fetch'))
  );
  const view = await mount();
  await act(async () => {
    await view.chat().send('Hello', { workspaceOnly: false });
  });
  expect(view.answer()?.status).toBe('error');
  expect(resumeChat).not.toHaveBeenCalled();
  await view.unmount();
});

// Only the shown conversation follows a turn it did not send: opening
// another stops reading without stopping the turn.
it('stops following a resumed turn when another conversation shows', async () => {
  const post = vi.spyOn(api, 'post');
  let signal: AbortSignal | undefined;
  connections.push((handlers, s) => {
    signal = s;
    return replaying('Mitochondria')(handlers, s);
  });
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', history, true));
  await act(async () => view.chat().startNew());

  expect(signal?.aborted).toBe(true);
  expect(post).not.toHaveBeenCalled();
  expect(view.chat().messages).toEqual([]);
  await view.unmount();
});

// Epo 2026-10-29: stored history paints at once but only this open's fetch
// decides whether a running turn is followed.
it('paints stored history without following, then follows the fetched one', async () => {
  connections.push(replaying('Mitochondria'));
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', history, false));

  expect(resumeChat).not.toHaveBeenCalled();
  expect(view.chat().streaming).toBe(false);
  expect(view.answer()?.id).toBe('m_1');

  await act(async () => view.chat().hydrate('c_1', history, true));
  expect(resumeChat).toHaveBeenCalledTimes(1);
  expect(view.chat().streaming).toBe(true);
  await view.unmount();
});

it('seeds a conversation from stored history once, then once from the fetch', () => {
  expect(seedsAgain(null, 'c_1', false)).toBe(true);
  expect(seedsAgain({ current: false, id: 'c_1' }, 'c_1', false)).toBe(false);
  expect(seedsAgain({ current: false, id: 'c_1' }, 'c_1', true)).toBe(true);
  expect(seedsAgain({ current: true, id: 'c_1' }, 'c_1', true)).toBe(false);
  expect(seedsAgain({ current: true, id: 'c_1' }, 'c_2', false)).toBe(true);
});

const answered: ChatMessage[] = [
  history[0] as ChatMessage,
  { ...(history[1] as ChatMessage), content: 'Energy', status: 'complete' },
];

// Epo 2026-10-29 (L1): a turn sent on the stored paint keeps the thread when
// the fetch lands, so the panel seeds from the fetch after that turn.
it('keeps a turn sent before the fetch landed and reports it did not seed', async () => {
  connections.push((handlers, signal) => {
    handlers.onStart?.({ conversationId: 'c_1', messageId: 'm_3' });
    return until(signal);
  });
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', answered, false));
  await act(async () => {
    void view.chat().send('And ATP?', { workspaceOnly: false });
  });

  let seeded = true;
  await act(async () => {
    seeded = view.chat().hydrate('c_1', answered, true);
  });

  expect(seeded).toBe(false);
  expect(view.chat().streaming).toBe(true);
  expect(view.chat().messages.at(-2)?.content).toBe('And ATP?');
  await view.unmount();
});

// Epo 2026-10-29 (L3): an Undo answered in this tab outlives a seed from
// history that still shows the edit.
it('shows this tab’s Undo outcome when the conversation seeds again', async () => {
  const edit: ResourceEffect = {
    operation: 'edited',
    operationId: 'op_1',
    resource: { id: 'f_1', kind: 'source_file', title: 'grades.xlsx' },
    undo: { operationId: 'op_1', status: 'available' },
  };
  const undone: ResourceEffect = {
    ...edit,
    operation: 'edit_undone',
    undo: { operationId: 'op_2', status: 'available' },
  };
  const edited: ChatMessage[] = [
    history[0] as ChatMessage,
    {
      activity: [
        {
          callId: 'call_1',
          effects: [edit],
          id: 't_1',
          kind: 'tool',
          name: 'edit_document',
          outcome: 'succeeded',
        },
      ],
      content: 'Edited',
      id: 'm_1',
      role: 'assistant',
      status: 'complete',
    },
  ];
  const effectShown = () => {
    const block = view.chat().messages.at(-1)?.activity?.[0];
    return block?.kind === 'tool' ? block.effects?.[0] : undefined;
  };
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', edited, false));
  await act(async () => view.chat().applyUndo('op_1', undone));
  await act(async () => view.chat().hydrate('c_1', edited, true));

  expect(effectShown()).toEqual(undone);

  // A refused Redo keeps its operation id: the walk stops on it.
  const refused = {
    ...undone,
    undo: { operationId: 'op_2', status: 'available' as const },
  };
  await act(async () => view.chat().refuseUndo(refused));
  await act(async () => view.chat().hydrate('c_1', edited, true));
  expect(effectShown()?.undo).toEqual({
    operationId: 'op_2',
    status: 'unavailable',
  });
  await view.unmount();
});

// A thread seeded from fetched history counts as seeded while this tab's turn
// streams, so coming back to it mid-answer does not seed it again after.
it('reports a thread seeded from fetched history as seeded during its turn', async () => {
  connections.push((handlers, signal) => {
    handlers.onStart?.({ conversationId: 'c_1', messageId: 'm_3' });
    return until(signal);
  });
  const view = await mount();
  await act(async () => view.chat().hydrate('c_1', answered, true));
  await act(async () => {
    void view.chat().send('And ATP?', { workspaceOnly: false });
  });

  let seeded = false;
  await act(async () => {
    seeded = view.chat().hydrate('c_1', answered, true);
  });

  expect(seeded).toBe(true);
  expect(view.chat().streaming).toBe(true);
  await view.unmount();
});
