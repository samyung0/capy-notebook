import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { streamChat } from '@/api/chatStream';
import { m } from '@/i18n';

const page = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  lists: [] as Record<string, unknown>[],
}));
vi.mock('@tanstack/react-router', () => ({
  useCanGoBack: () => false,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouter: () => ({ history: { back: vi.fn() } }),
}));
vi.mock('@/api/auth', () => ({
  authHeaders: async () => ({}),
  USE_MSW: false,
}));
vi.mock('@/api/hooks', () => ({
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
});

it('shows the Chats panel beside a Chat panel filling the rest, with no centre pane', () => {
  const html = renderToStaticMarkup(<AccountChat />);
  expect(html.match(/<section>/g)).toHaveLength(2);
  const [chats, chat] = html.split('<section>').slice(1);
  expect(chats).toContain('data-chat-list');
  expect(chat).toContain('data-chat-panel');
  expect(chat).toContain(m.chat_all_your_files());
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
