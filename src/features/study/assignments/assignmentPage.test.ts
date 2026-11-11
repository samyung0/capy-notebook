import { expect, it } from 'vitest';
import type { Assignment } from '@/api/types';
import { assignmentPage, fileLink } from './assignmentPage';

it("opens a task's pages in its workspace, or on To do's page with none", () => {
  expect(
    assignmentPage({ id: 'as1', workspaceId: 'ws1' }, { tab: 'approve' })
  ).toEqual({
    params: { workspaceId: 'ws1' },
    search: { assignment: 'as1', study: 'assignments', tab: 'approve' },
    to: '/workspaces/$workspaceId',
  });
  expect(assignmentPage({ id: 'as2', workspaceId: '' })).toEqual({
    search: { assignment: 'as2', study: 'assignments' },
    to: '/todo/task',
  });
});

it('opens a file where it sits, whatever workspace its task is in', () => {
  const file = (ref: Partial<Assignment['files'][number]>) =>
    ref as Assignment['files'][number];
  expect(fileLink(file({ fileId: 'f1', workspaceId: 'other' }))).toEqual({
    params: { workspaceId: 'other' },
    search: { file: 'f1' },
    to: '/workspaces/$workspaceId',
  });
  expect(fileLink(file({ fileId: 'f2' }))).toEqual({
    params: { fileId: 'f2' },
    to: '/files/$fileId',
  });
  expect(fileLink(file({ materialId: 'm1' }))).toEqual({
    params: { materialId: 'm1' },
    to: '/materials/$materialId',
  });
});
