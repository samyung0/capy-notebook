import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { API_BASE } from '@/api/client';
import { workspaceQuery, workspacesQuery } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import {
  opensDashboard,
  prefetchAssignments,
  prefetchDashboard,
  prefetchMembers,
  prefetchStudy,
} from './workspacePreload';

vi.mock('@/api/auth', () => ({
  authHeaders: async () => ({}),
  USE_MSW: false,
}));

/** The paths the reads asked for, in order. */
function requests() {
  const fetch = vi.fn<(url: string) => Promise<Response>>(
    async () => new Response('{}')
  );
  vi.stubGlobal('fetch', fetch);
  return () =>
    fetch.mock.calls.map(([url]) =>
      decodeURIComponent(url.slice(API_BASE.length))
    );
}

/** Lets the reads' requests go out: auth headers come first. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A client holding the workspace, as the rail's hover finds it. */
function withWorkspace(workspace: Partial<Workspace>) {
  const qc = new QueryClient();
  qc.setQueryData(workspaceQuery('ws').queryKey, {
    capabilities: { canManageMembers: false },
    id: 'ws',
    kind: 'personal',
    role: 'viewer',
    ...workspace,
  } as Workspace);
  return qc;
}

afterEach(() => vi.unstubAllGlobals());

// Q906: a workspace card's link opens the Dashboard, so its loader (and the
// card's hover) starts the Dashboard's reads with the workspace's own.
it('opens the Dashboard only for the workspace URL with no item, view or page', () => {
  expect(opensDashboard('/workspaces/ws', {})).toBe(true);
  expect(opensDashboard('/workspaces/ws/', {})).toBe(true);
  expect(opensDashboard('/workspaces/ws', { file: 'f' })).toBe(false);
  expect(opensDashboard('/workspaces/ws', { material: 'm' })).toBe(false);
  expect(opensDashboard('/workspaces/ws', { view: 'files' })).toBe(false);
  expect(opensDashboard('/workspaces/ws/members', {})).toBe(false);
});

it("starts the Dashboard's reads together", async () => {
  const asked = requests();
  prefetchDashboard(new QueryClient(), 'ws');
  await settle();
  expect(asked()).toEqual([
    '/workspaces/ws/dashboard',
    '/workspaces/ws/recent',
    '/todo',
    '/learning/continue?workspaceId=ws',
  ]);
});

// Q911: the workspace list the card was picked from already names its staff.
it("adds a class staff's To grade when the workspace list says so", async () => {
  const asked = requests();
  const qc = new QueryClient();
  qc.setQueryData(workspacesQuery({ sort: 'accessed' }).queryKey, [
    { id: 'ws', kind: 'class', role: 'owner' } as Workspace,
  ]);
  prefetchDashboard(qc, 'ws');
  await settle();
  expect(asked()).toContain(
    '/workspaces/ws/assignments?closed=true&done=true&pending=true'
  );
});

// Q907: Study's Frequently wrong went out only after topics and practice.
it("starts a member's Study reads in one wave, Frequently wrong included", async () => {
  const asked = requests();
  prefetchStudy(withWorkspace({}), 'ws', 'summary', {});
  await settle();
  expect(asked()).toEqual([
    '/workspaces/ws/practice',
    '/workspaces/ws/study/topics',
    '/workspaces/ws/study/questions?list=wrong',
  ]);
});

it("starts a class staff's Study on every member's marks", async () => {
  const asked = requests();
  prefetchStudy(
    withWorkspace({ kind: 'class', role: 'owner' }),
    'ws',
    'summary',
    {}
  );
  await settle();
  expect(asked()).toEqual(['/workspaces/ws/study/members']);
});

it('starts Members with the invites and member lines for class staff', async () => {
  const asked = requests();
  prefetchMembers(
    withWorkspace({
      capabilities: { canManageMembers: true } as Workspace['capabilities'],
      kind: 'class',
      role: 'owner',
    }),
    'ws'
  );
  await settle();
  expect(asked()).toEqual([
    '/workspaces/ws/members',
    '/workspaces/ws/invites',
    '/workspaces/ws/study/members',
  ]);
});

it('starts the Assignments list as the page first asks, or the assignment its URL opens', async () => {
  const asked = requests();
  prefetchAssignments(new QueryClient(), 'ws', {});
  prefetchAssignments(new QueryClient(), 'ws', { assignment: 'a_1' });
  await settle();
  expect(asked()).toEqual([
    '/workspaces/ws/assignments?closed=false&dir=desc&done=true&sort=posted',
    '/assignments/a_1',
  ]);
});
