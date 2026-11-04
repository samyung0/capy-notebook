import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { WorkspaceDashboard as Dashboard } from '@/api/types';
import { m } from '@/i18n';
import { shortTime, WorkspaceDashboard } from './WorkspaceDashboard';

const page = vi.hoisted(() => ({
  data: undefined as Dashboard | undefined,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    search,
  }: {
    children: ReactNode;
    search: Record<string, string>;
  }) => <a href={`?${new URLSearchParams(search)}`}>{children}</a>,
}));

vi.mock('@/api/hooks', () => ({
  useWorkspaceDashboard: () => ({ data: page.data }),
  useWorkspaceRecent: () => ({ data: { files: [], materials: [] } }),
}));

const render = () =>
  renderToStaticMarkup(
    <WorkspaceDashboard
      onUpload={() => undefined}
      workspace={{
        capabilities: { canEdit: true } as never,
        id: 'ws',
        name: 'Biology 101',
      }}
    />
  );

it('opens each activity row on its file or material', () => {
  page.data = {
    activity: [
      {
        actorName: 'Cara',
        at: '2026-11-04T08:00:00Z',
        fileId: 'f_1',
        kind: 'uploaded',
        title: 'Week 2.pptx',
      },
      {
        at: '2026-11-03T08:00:00Z',
        kind: 'agent',
        materialId: 'm_1',
        title: 'Cell cards',
      },
    ],
    members: 7,
    ownerName: 'Ms Wong',
  };
  const html = render();
  expect(html).toContain('href="?file=f_1"');
  expect(html).toContain('href="?material=m_1"');
});

it('leaves out an empty section, with no hint in its place', () => {
  page.data = { activity: [], members: 1, ownerName: 'Ms Wong' };
  const html = render();
  expect(html).toContain('Biology 101');
  expect(html).not.toContain(m.dashboard_activity());
  expect(html).not.toContain(m.dashboard_recent_files());
});

it('writes times as the boards do', () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  expect(shortTime(new Date(2026, 10, 4, 10).toISOString(), now)).toBe(
    m.dashboard_hours({ count: 2 })
  );
  expect(shortTime(new Date(2026, 10, 2, 10).toISOString(), now)).toBe(
    new Intl.DateTimeFormat('en', { weekday: 'short' }).format(
      new Date(2026, 10, 2)
    )
  );
});
