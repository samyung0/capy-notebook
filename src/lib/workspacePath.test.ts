import { expect, it } from 'vitest';
import { workspaceOfPath } from './workspacePath';

// A workspace's pages are child routes: its event stream and an update load
// treat them as the workspace (2026-11-18 routes review).
it('reads the workspace from its pages as from its own path', () => {
  expect(workspaceOfPath('/workspaces/ws1')).toBe('ws1');
  expect(workspaceOfPath('/workspaces/ws1/study/practice')).toBe('ws1');
  expect(workspaceOfPath('/workspaces')).toBe('');
});
