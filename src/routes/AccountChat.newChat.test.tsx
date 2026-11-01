import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

// linkedom's document before react-dom/client loads, which reads it once.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

const page = vi.hoisted(() => ({ chat: {} as Record<string, unknown> }));
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
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@/api/queryClient', () => ({ showErrorToast: vi.fn() }));
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
// The toolbar's tooltip needs a fuller DOM than linkedom's.
vi.mock('@/components/ui/ToolbarButton', () => ({
  ToolbarButton: (props: {
    children: ReactNode;
    disabled?: boolean;
    label: string;
    onClick: () => void;
  }) => (
    <button
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  ),
}));
vi.mock('@/features/workspace/ChatPanel', () => ({
  ChatPanel: (props: { renderTabRow: () => ReactNode }) => {
    page.chat = props;
    return <div>{props.renderTabRow()}</div>;
  },
}));
vi.mock('@/features/workspace/chat/ConversationList', () => ({
  ConversationList: () => null,
}));
vi.mock('@/features/workspace/chat/ArchivedChatsDialog', () => ({
  ArchivedChatsDialog: () => null,
}));
vi.mock('@/features/workspace/chat/ChatHistoryDialog', () => ({
  ChatHistoryDialog: () => null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { m } = await import('@/i18n');
const { default: AccountChat } = await import('./AccountChat');

// A first send refused before it got a conversation (out of credits) keeps
// its message and error on /chat; New chat still opens a new chat (Epo
// 2026-10-29).
it('opens a new chat from a first send that got no conversation', async () => {
  const root = createRoot(document.getElementById('root') as Element);
  await act(async () => root.render(<AccountChat />));
  const button = () =>
    document.querySelector(
      `[aria-label="${m.chat_new()}"]`
    ) as HTMLButtonElement;
  expect(button().disabled).toBe(true);

  const onActiveChange = page.chat.onActiveChange as (
    id: string | null,
    shown: boolean
  ) => void;
  await act(async () => onActiveChange(null, true));
  expect(button().disabled).toBe(false);

  await act(async () =>
    button().dispatchEvent(new window.Event('click', { bubbles: true }))
  );
  expect(page.chat.request).toMatchObject({ id: null, seq: 1 });
  act(() => root.unmount());
});
