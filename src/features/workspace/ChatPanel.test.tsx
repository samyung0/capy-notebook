import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { ChatMessage, Conversation } from '@/api/types';
import { getLocale, m } from '@/i18n';
import type { ChatRequest } from './ChatPanel';

// The locale resolves before a window exists (see EmbedsTab.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
// React reads `oninput` on the document to know input events exist.
Object.assign(document, { oninput: null });

// What the selected thread's messages read answers with.
const thread = vi.hoisted(() => ({
  asked: [] as (string | null)[],
  conversations: [] as Conversation[],
  error: null as unknown,
}));
vi.mock('@/api/hooks', async (original) => ({
  ...(await original<typeof import('@/api/hooks')>()),
  useConversations: () => ({ data: thread.conversations }),
  useMe: () => ({ data: undefined }),
  useMessages: (id: string | null) => {
    thread.asked.push(id);
    return { data: undefined, error: id ? thread.error : null };
  },
  useWorkspaces: () => ({ data: [{ iconId: 'flask', id: 'ws_bio' }] }),
}));
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => true }));
// The real stream, but turns only reach this spy.
const stream = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./useChatStream', async (original) => {
  const actual = await original<typeof import('./useChatStream')>();
  return {
    ...actual,
    useChatStream: (workspaceId: string | null) => ({
      ...actual.useChatStream(workspaceId),
      send: stream.send,
    }),
  };
});
// The scope menu's items render in place.
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({
    items,
    trigger,
  }: {
    items: { label: string }[];
    trigger: ReactNode;
  }) => (
    <>
      {trigger}
      {items.map((item) => (
        <span data-menu-item key={item.label}>
          {item.label}
        </span>
      ))}
    </>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ChatPanel, Citations } = await import('./ChatPanel');
const { ConversationList } = await import('./chat/ConversationList');

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  );

it('names where each account citation lives, and leaves workspace citations as they were', () => {
  const msg: ChatMessage = {
    citations: [
      {
        fileId: 'f_2',
        fileName: 'Organelles cheatsheet.md',
        snippet: '',
        workspaceId: 'ws_bio',
        workspaceName: 'Biology 101',
      },
      {
        fileId: 'f_standalone_md',
        fileName: 'Reading list.md',
        snippet: '',
        workspaceId: '',
        workspaceName: '',
      },
      { fileId: 'f_1', fileName: 'Cell structure.pdf', snippet: '' },
    ],
    content: '',
    id: 'm_1',
    role: 'assistant',
    status: 'complete',
  };
  const html = render(<Citations msg={msg} />);
  const badges = html.split('<button').slice(1);
  expect(badges[0]).toContain('Biology 101');
  expect(badges[0]).toContain('flask');
  expect(badges[0]).toContain('Organelles cheatsheet.md');
  expect(badges[1]).not.toContain('·');
  expect(badges[1]).toContain('Reading list.md');
  expect(badges[2]).not.toContain('·');
  expect(badges[2]).toContain('Cell structure.pdf');
});

it('shows a library citation as its book and pages', () => {
  const msg: ChatMessage = {
    citations: [
      {
        excerptId: 'exc_bio_185',
        fileId: '',
        fileName: 'Concepts of Biology',
        kind: 'library',
        pageEnd: 130,
        pageStart: 129,
        snippet: 'Water moves down its concentration gradient.',
      },
    ],
    content: '',
    id: 'm_1',
    role: 'assistant',
    status: 'complete',
  };
  const html = render(<Citations msg={msg} />);
  expect(html).toContain('Concepts of Biology');
  expect(html).toContain('pp. 129–130');
});

it('reads Your files only in the account chat and Workspace only in a workspace', () => {
  const account = render(<ChatPanel workspaceId={null} />);
  expect(account).toContain(m.chat_your_files_only());
  expect(account).not.toContain(m.chat_workspace_only());

  const workspace = render(<ChatPanel workspaceId="ws_bio" />);
  expect(workspace).toContain(m.chat_workspace_only());
  expect(workspace).not.toContain(m.chat_your_files_only());
});

it('says a linked thread that answers 404 is not found, not an empty chat', async () => {
  thread.error = new ApiError(404, 'Not Found');
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatPanel request={{ id: 'c_gone', seq: 1 }} workspaceId={null} />
      </QueryClientProvider>
    )
  );
  const text = document.body.textContent ?? '';
  expect(text).toContain(m.error_not_found_title());
  expect(text).toContain(m.error_not_found_body());
  expect(text).not.toContain(m.chat_empty());
  act(() => root.unmount());
});

it('puts the caret in the composer for each chat it opens only when asked (the account chat page)', async () => {
  thread.error = null;
  const textarea = (
    window as unknown as {
      HTMLTextAreaElement: { prototype: { focus: () => void } };
    }
  ).HTMLTextAreaElement.prototype;
  const original = textarea.focus;
  const focus = vi.fn();
  textarea.focus = focus;
  const panel = (request: ChatRequest, focusOnOpen?: boolean) => (
    <QueryClientProvider client={new QueryClient()}>
      <ChatPanel
        focusOnOpen={focusOnOpen}
        request={request}
        workspaceId={null}
      />
    </QueryClientProvider>
  );
  const root = createRoot(document.getElementById('root') as never);
  // A new chat, then the thread left off last time.
  await act(async () => root.render(panel({ id: null, seq: 1 }, true)));
  expect(focus).toHaveBeenCalledTimes(1);
  await act(async () => root.render(panel({ id: 'c_last', seq: 2 }, true)));
  expect(focus).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
  // A workspace's rail chat keeps the caret where the learner left it.
  const rail = createRoot(document.getElementById('root') as never);
  await act(async () => rail.render(panel({ id: null, seq: 1 })));
  expect(focus).toHaveBeenCalledTimes(2);
  act(() => rail.unmount());
  textarea.focus = original;
});

it('sends a spoken question once as a new chat, not again when the panel mounts anew', async () => {
  const request = {
    id: null,
    prompt: 'What does the Krebs cycle make?',
    seq: 1,
  };
  const mount = async () => {
    const root = createRoot(document.getElementById('root') as never);
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ChatPanel request={request} workspaceId="ws_bio" />
        </QueryClientProvider>
      )
    );
    act(() => root.unmount());
  };
  await mount();
  await mount();
  expect(stream.send).toHaveBeenCalledTimes(1);
  expect(stream.send.mock.calls[0][0]).toBe(request.prompt);
});

/** localStorage holding `entries`, as a reload finds it. */
function keptChats(entries: Record<string, string>) {
  const stored = new Map(Object.entries(entries));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => stored.delete(key),
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  return stored;
}

it('reopens the chat a reload kept in its own scope, behind a request it mounts with (T19)', async () => {
  const stored = keptChats({
    'capy.chat.open.account': '"c_kept"',
    'capy.chat.open.ws_bio': '"c_ws"',
  });
  const firstAsked = async (node: ReactNode) => {
    thread.asked = [];
    const root = createRoot(document.getElementById('root') as never);
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          {node}
        </QueryClientProvider>
      )
    );
    const text = document.body.textContent ?? '';
    act(() => root.unmount());
    return { asked: thread.asked, first: thread.asked[0], text };
  };
  expect((await firstAsked(<ChatPanel workspaceId="ws_bio" />)).first).toBe(
    'c_ws'
  );
  stored.set('capy.chat.open.account', '"c_kept"');
  const linked = await firstAsked(
    <ChatPanel request={{ id: 'c_url', seq: 0 }} workspaceId={null} />
  );
  expect(linked.first).toBe('c_url');
  expect(linked.asked).not.toContain('c_kept');
  // A kept chat that is gone opens a new chat; a linked one says not found.
  stored.set('capy.chat.open.account', '"c_kept"');
  thread.error = new ApiError(404, 'Not Found');
  const gone = await firstAsked(<ChatPanel workspaceId={null} />);
  expect(gone.first).toBe('c_kept');
  expect(gone.text).toContain(m.chat_empty());
  expect(gone.text).not.toContain(m.error_not_found_title());
  thread.error = null;
  vi.unstubAllGlobals();
});

// Epo 2026-10-29, Q576 F1: a page switch in place leaves the shown chat filed
// under the workspace it was shown in.
it('keeps the shown chat under the workspace it opened in when the page switches workspace in place', async () => {
  const stored = keptChats({ 'capy.chat.open.ws_a': '"c_a"' });
  const client = new QueryClient();
  const panel = (workspaceId: string) => (
    <QueryClientProvider client={client}>
      <ChatPanel workspaceId={workspaceId} />
    </QueryClientProvider>
  );
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(panel('ws_a')));
  await act(async () => root.render(panel('ws_b')));
  expect(stored.get('capy.chat.open.ws_a')).toBe('"c_a"');
  expect(stored.has('capy.chat.open.ws_b')).toBe(false);
  act(() => root.unmount());
  expect(stored.has('capy.chat.open.ws_a')).toBe(false);
  vi.unstubAllGlobals();
});

// Epo 2026-10-29, Q576 F3: a send while the kept chat opens would start a new
// chat that the opened one then replaces.
it('holds a send until the kept chat has opened', async () => {
  keptChats({ 'capy.chat.open.account': '"c_kept"' });
  stream.send.mockClear();
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatPanel workspaceId={null} />
      </QueryClientProvider>
    )
  );
  const field = document.querySelector('textarea') as HTMLTextAreaElement;
  const proto = (
    window as unknown as { HTMLTextAreaElement: { prototype: object } }
  ).HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(
      field,
      'And ATP?'
    );
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const send = [...document.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === m.chat_send()
  );
  expect(send?.hasAttribute('disabled')).toBe(true);
  await act(async () => {
    send?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(stream.send).not.toHaveBeenCalled();
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

// Epo 2026-10-29, Q576 F4 (T19): the panel already shows its chat's answer live.
it('spins only on running chats other than the one the panel shows', () => {
  const row = (id: string): Conversation => ({
    createdAt: '2026-10-29T00:00:00Z',
    id,
    running: true,
    title: id,
    updatedAt: '2026-10-29T00:00:00Z',
    workspaceId: '',
  });
  thread.conversations = [row('c_shown'), row('c_other')];
  const html = render(
    <ConversationList
      activeId="c_shown"
      onOpen={() => undefined}
      onRemoved={() => undefined}
      workspaceId={null}
    />
  );
  thread.conversations = [];
  const rows = html.split('<button').filter((part) => part.includes('c_'));
  const spins = (id: string) =>
    rows.find((part) => part.includes(id))?.includes(m.chat_running());
  expect(spins('c_shown')).toBe(false);
  expect(spins('c_other')).toBe(true);
});
