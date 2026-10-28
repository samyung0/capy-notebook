import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';

const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    to,
  }: {
    children: ReactNode;
    className?: string;
    to: string;
  }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: route.pathname } }),
}));
vi.mock('@/api/hooks', () => ({
  useUnreadNotificationCount: () => ({ data: { count: 0 } }),
}));
vi.mock('@/features/guide/GettingStartedRow', () => ({
  GettingStartedRow: () => null,
}));
vi.mock('./SearchDialog', () => ({ SearchDialog: () => null }));
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
