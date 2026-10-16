import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Task } from '@/api/types';
import { m } from '@/i18n';

const tasks = vi.hoisted(() => ({ data: undefined as Task[] | undefined }));
vi.mock('@/api/hooks', () => ({
  useTasks: () => ({
    data: tasks.data,
    fetchStatus: 'paused',
    isLoading: false,
  }),
  useToggleTask: () => ({ mutate: () => undefined }),
}));
vi.mock('@/components/app/layout', () => ({
  PageHeader: () => null,
  PanelWithInvertedRadius: ({ children }: { children: ReactNode }) => children,
}));
const { default: Tasks } = await import('./Tasks');

it('keeps showing the tasks it holds while their refetch waits for the connection', () => {
  tasks.data = [
    { done: false, dueDate: '2026-10-17', id: 't_1', title: 'Read chapter 3' },
  ];
  const held = renderToStaticMarkup(<Tasks />);
  expect(held).toContain('Read chapter 3');
  expect(held).not.toContain(m.connection_waiting());

  tasks.data = undefined;
  expect(renderToStaticMarkup(<Tasks />)).toContain(m.connection_waiting());
});
