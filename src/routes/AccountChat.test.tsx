import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { streamChat } from '@/api/chatStream';
import { ApiError } from '@/api/client';

const page = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  // What the fresh item read throws, if anything.
  fail: null as unknown,
  lists: [] as Record<string, unknown>[],
  navigate: vi.fn(),
  toast: vi.fn(),
  // Where the server says an item lives now ('' for no workspace).
  where: '',
}));
vi.mock('@tanstack/react-router', () => ({
  useCanGoBack: () => false,
  useNavigate: () => page.navigate,
  useParams: () => ({}),
  useRouter: () => ({ history: { back: vi.fn() } }),
}));
vi.mock('@/api/auth', () => ({
  authHeaders: async () => ({}),
  USE_MSW: false,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    fetchQuery: async () => {
      if (page.fail) throw page.fail;
      return { workspaceId: page.where || undefined };
    },
  }),
}));
vi.mock('@/api/queryClient', () => ({ showErrorToast: page.toast }));
vi.mock('@/api/hooks', () => ({
  fileQuery: (id: string) => ({ queryKey: ['file', id] }),
  materialQuery: (id: string) => ({ queryKey: ['material', id] }),
  useUnreadNotificationCount: () => ({ data: { count: 0 } }),
}));
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('@/components/app/layout', () => ({
  Panel: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock('@/components/app/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/app/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('@/features/workspace/ChatPanel', () => ({
  ChatPanel: (props: { renderTabRow: () => ReactNode }) => {
    page.chat = props;
    return <div data-chat-panel>{props.renderTabRow()}</div>;
  },
}));
vi.mock('@/features/workspace/chat/ConversationList', () => ({
  ConversationList: (props: Record<string, unknown>) => {
    page.lists.push(props);
    return <div data-chat-list />;
  },
}));
vi.mock('@/features/workspace/chat/ArchivedChatsDialog', () => ({
  ArchivedChatsDialog: () => null,
}));
vi.mock('@/features/workspace/chat/ChatHistoryDialog', () => ({
  ChatHistoryDialog: () => null,
}));

const { default: AccountChat } = await import('./AccountChat');

afterEach(() => {
  vi.unstubAllGlobals();
  page.fail = null;
  page.navigate.mockClear();
  page.toast.mockClear();
});

it('shows the Chats panel beside a Chat panel filling the rest, with no centre pane', () => {
  const html = renderToStaticMarkup(<AccountChat />);
  expect(html.match(/<section>/g)).toHaveLength(2);
  const [chats, chat] = html.split('<section>').slice(1);
  expect(chats).toContain('data-chat-list');
  expect(chat).toContain('data-chat-panel');
  expect(page.lists[0]).toMatchObject({ workspaceId: null });
  expect(page.chat).toMatchObject({ fill: true, workspaceId: null });
});

it('posts an account turn to the account chat stream', async () => {
  const fetch = vi.fn(
    async () => new Response('data: {"type":"done","status":"complete"}\n\n')
  );
  vi.stubGlobal('fetch', fetch);
  await streamChat(null, { text: 'hi', workspaceOnly: true }, {});
  expect(fetch).toHaveBeenCalledWith(
    '/api/chat/stream',
    expect.objectContaining({
      body: JSON.stringify({ text: 'hi', workspaceOnly: true }),
      method: 'POST',
    })
  );
});

it('opens a citation where its file lives now, not where the answer found it', async () => {
  renderToStaticMarkup(<AccountChat />);
  const open = page.chat.onOpenCitation as (citation: object) => void;

  page.where = 'ws_now';
  open({ fileId: 'f_1', pageStart: 3, workspaceId: 'ws_old' });
  await vi.waitFor(() =>
    expect(page.navigate).toHaveBeenLastCalledWith({
      params: { workspaceId: 'ws_now' },
      search: { file: 'f_1', page: 3 },
      to: '/workspaces/$workspaceId',
    })
  );
  page.where = '';
  open({ fileId: 'f_1', pageStart: 3, workspaceId: 'ws_old' });
  await vi.waitFor(() =>
    expect(page.navigate).toHaveBeenLastCalledWith({
      params: { fileId: 'f_1' },
      to: '/files/$fileId',
    })
  );
});

it('opens a citation whose file answers 404 on its own page', async () => {
  renderToStaticMarkup(<AccountChat />);
  const open = page.chat.onOpenCitation as (citation: object) => void;

  page.fail = new ApiError(404, 'Not Found');
  open({ fileId: 'f_gone', workspaceId: 'ws_old' });
  await vi.waitFor(() =>
    expect(page.navigate).toHaveBeenLastCalledWith({
      params: { fileId: 'f_gone' },
      to: '/files/$fileId',
    })
  );
  expect(page.toast).not.toHaveBeenCalled();
});

it.each([
  ['a server error', new ApiError(500, 'Internal Server Error')],
  ['a network error', new TypeError('Failed to fetch')],
])(
  'toasts and stays on the chat when the cited file read fails with %s',
  async (_, error) => {
    renderToStaticMarkup(<AccountChat />);
    const open = page.chat.onOpenCitation as (citation: object) => void;

    page.fail = error;
    open({ fileId: 'f_1', workspaceId: 'ws_old' });
    await vi.waitFor(() => expect(page.toast).toHaveBeenCalledWith(error));
    expect(page.navigate).not.toHaveBeenCalled();
  }
);
