import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/api/types';
import { m } from '@/i18n';

vi.mock('@/api/hooks', async (original) => ({
  ...(await original<typeof import('@/api/hooks')>()),
  useConversations: () => ({ data: [] }),
  useMe: () => ({ data: undefined }),
  useMessages: () => ({ data: undefined }),
  useWorkspaces: () => ({ data: [{ iconId: 'flask', id: 'ws_bio' }] }),
}));
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

const { ChatPanel, Citations } = await import('./ChatPanel');

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
  expect(badges[1]).toContain(m.files_no_workspace());
  expect(badges[1]).toContain('Reading list.md');
  expect(badges[2]).not.toContain('·');
  expect(badges[2]).toContain('Cell structure.pdf');
});

it('reads Your files only in the account chat and Workspace only in a workspace', () => {
  const account = render(<ChatPanel workspaceId={null} />);
  expect(account).toContain(m.chat_your_files_only());
  expect(account).not.toContain(m.chat_workspace_only());

  const workspace = render(<ChatPanel workspaceId="ws_bio" />);
  expect(workspace).toContain(m.chat_workspace_only());
  expect(workspace).not.toContain(m.chat_your_files_only());
});
