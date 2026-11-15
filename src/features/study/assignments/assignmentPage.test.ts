import { expect, it } from 'vitest';
import type { Assignment } from '@/api/types';
import { assignmentPage, fileLink, reportView } from './assignmentPage';

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

// Epo 2026-11-15: a graded quiz's tabs are Questions | Responses | Settings.
it("gives each report its tabs, a graded quiz's draft no Responses", () => {
  const tabs = (kind: Assignment['kind'], draft: boolean) =>
    reportView({ draft, kind }, {}).tabs;
  expect(tabs('marked', false)).toEqual(['questions', 'responses', 'settings']);
  expect(tabs('marked', true)).toEqual(['questions', 'settings']);
  expect(tabs('unmarked', false)).toEqual(['members', 'settings', 'preview']);
  expect(tabs('unmarked', true)).toEqual(['settings', 'preview']);
});

it("opens a graded quiz's older links on Responses", () => {
  const quiz = { draft: false, kind: 'marked' as const };
  expect(reportView(quiz, { tab: 'members' })).toMatchObject({
    approving: false,
    tab: 'responses',
  });
  expect(reportView(quiz, { tab: 'approve' })).toMatchObject({
    approving: true,
    tab: 'responses',
  });
  expect(reportView(quiz, { tab: 'preview' }).tab).toBe('questions');
  expect(
    reportView(quiz, { by: 'question', tab: 'responses' }).byQuestion
  ).toBe(true);
  // A task keeps Members as its own tab.
  expect(
    reportView({ draft: false, kind: 'unmarked' }, { tab: 'members' }).tab
  ).toBe('members');
});
