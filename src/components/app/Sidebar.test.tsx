import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';

const route = vi.hoisted(() => ({ pathname: '/' }));
const recording = vi.hoisted(() => ({ type: null as string | null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    'aria-label': label,
    children,
    className,
    to,
  }: {
    'aria-label'?: string;
    children: ReactNode;
    className?: string;
    to: string;
  }) => (
    <a aria-label={label} className={className} href={to}>
      {children}
    </a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: route.pathname } }),
}));
const todo = vi.hoisted(() => ({ workspaces: [] as object[] }));
vi.mock('@/api/hooks', () => ({
  useTodo: () => ({ data: todo }),
  useUnreadNotificationCount: () => ({ data: { count: 0 } }),
}));
vi.mock('@/features/guide/GettingStartedRow', () => ({
  GettingStartedRow: () => null,
}));
vi.mock('./SearchDialog', () => ({ SearchDialog: () => null }));
vi.mock('@/features/workspace/chat/voiceRecording', () => ({
  recordingType: () => recording.type,
}));
vi.mock('./ProfileMenu', () => ({
  ProfileMenu: () => null,
  ProfileRow: () => null,
}));

const { Sidebar } = await import('./Sidebar');

/** The nav row linking to `href`. */
const row = (html: string, href: string) =>
  html.split('<a ').find((link) => link.includes(`href="${href}"`));

it('opens the account chat at /chat from its Chat row, active there', () => {
  const chat = row(renderToStaticMarkup(<Sidebar account />), '/chat');
  expect(chat).toContain(m.nav_chat());
  expect(chat).not.toContain('bg-action');

  route.pathname = '/chat/conv_1';
  expect(row(renderToStaticMarkup(<Sidebar account />), '/chat')).toContain(
    'bg-action'
  );
});

it('puts a dot on the To do row while anything is open', () => {
  expect(row(renderToStaticMarkup(<Sidebar />), '/todo')).not.toContain(
    'animate-pulse'
  );
  todo.workspaces = [
    {
      items: [{ draft: false, id: 'a', mine: { done: false } }],
      manages: false,
      workspaceId: 'w',
    },
  ];
  const todoRow = row(renderToStaticMarkup(<Sidebar />), '/todo');
  expect(todoRow).toContain('animate-pulse');
  expect(todoRow).toContain(m.todo_nav_count({ count: '1' }));
});
