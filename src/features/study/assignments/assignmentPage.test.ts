import { expect, it } from 'vitest';
import type { Assignment } from '@/api/types';
import { assignmentPage, fileLink, reportView } from './assignmentPage';

it("opens a task's pages in its workspace, or on To do's page with none", () => {
  expect(
    assignmentPage({ id: 'as1', workspaceId: 'ws1' }, { tab: 'grading' })
  ).toEqual({
    params: { workspaceId: 'ws1' },
    search: { assignment: 'as1', tab: 'grading' },
    to: '/workspaces/$workspaceId/assignments',
  });
  expect(assignmentPage({ id: 'as2', workspaceId: '' })).toEqual({
    search: { assignment: 'as2' },
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

// Epo 2026-11-15: a graded quiz's tabs are Questions | Responses | Settings,
// Grading before Settings since 2026-11-19.
it("gives each report its tabs, a graded quiz's draft no Responses", () => {
  const tabs = (
    kind: Assignment['kind'],
    draft: boolean,
    task: Partial<Pick<Assignment, 'allowUploads' | 'points'>> = {}
  ) => reportView({ allowUploads: false, draft, kind, ...task }, {}).tabs;
  expect(tabs('marked', false)).toEqual([
    'questions',
    'responses',
    'grading',
    'settings',
  ]);
  expect(tabs('marked', true)).toEqual(['questions', 'settings']);
  expect(tabs('unmarked', false)).toEqual(['members', 'settings']);
  expect(tabs('unmarked', true)).toEqual(['settings']);
  // Epo 2026-11-19: Grading for one taking files or graded on points.
  expect(tabs('unmarked', false, { allowUploads: true })).toEqual([
    'members',
    'grading',
    'settings',
  ]);
  expect(tabs('unmarked', false, { points: 20 })).toEqual([
    'members',
    'grading',
    'settings',
  ]);
});

it("opens a graded quiz's older links on Responses", () => {
  const quiz = { allowUploads: false, draft: false, kind: 'marked' as const };
  expect(reportView(quiz, { tab: 'members' }).tab).toBe('responses');
  expect(
    reportView(quiz, { by: 'question', tab: 'responses' }).byQuestion
  ).toBe(true);
  // A task keeps Members as its own tab.
  expect(
    reportView(
      { allowUploads: false, draft: false, kind: 'unmarked' },
      { tab: 'members' }
    ).tab
  ).toBe('members');
});
