import { expect, it } from 'vitest';
import type { Assignment } from '@/api/types';
import { fileLink, reportView } from './assignmentPage';

it("opens an assignment's file in its class", () => {
  expect(fileLink('ws1', { fileId: 'f1' })).toEqual({
    params: { workspaceId: 'ws1' },
    search: { file: 'f1' },
    to: '/workspaces/$workspaceId',
  });
  expect(fileLink('ws1', { materialId: 'm1' })).toEqual({
    params: { workspaceId: 'ws1' },
    search: { material: 'm1' },
    to: '/workspaces/$workspaceId',
  });
});

// Epo 2026-11-15: a graded quiz's tabs are Questions | Responses | Settings,
// Grading before Settings since 2026-11-19.
it("gives each report its tabs, a graded quiz's draft no Responses", () => {
  const tabs = (
    kind: Assignment['kind'],
    draft: boolean,
    allowUploads = false
  ) => reportView({ allowUploads, draft, kind }, {}).tabs;
  expect(tabs('marked', false)).toEqual([
    'questions',
    'responses',
    'grading',
    'settings',
  ]);
  expect(tabs('marked', true)).toEqual(['questions', 'settings']);
  // Epo 2026-11-21: an Assignment's Content and Responses, as a quiz's.
  expect(tabs('unmarked', false)).toEqual(['content', 'responses', 'settings']);
  expect(tabs('unmarked', true)).toEqual(['settings']);
  // Epo 2026-11-25: one taking files lists its members on Grading alone.
  expect(tabs('unmarked', false, true)).toEqual([
    'content',
    'grading',
    'settings',
  ]);
});

it('opens a tab the report has, else its first', () => {
  const quiz = { allowUploads: false, draft: false, kind: 'marked' as const };
  expect(
    reportView(quiz, { by: 'question', tab: 'responses' }).byQuestion
  ).toBe(true);
  expect(reportView(quiz, { tab: 'content' }).tab).toBe('questions');
  // A link to an Assignment taking files' Responses lands on its Grading.
  const files = { allowUploads: true, draft: false, kind: 'unmarked' as const };
  expect(reportView(files, { tab: 'responses' }).tab).toBe('grading');
});
