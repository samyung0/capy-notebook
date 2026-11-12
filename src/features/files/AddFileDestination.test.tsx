import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { Workspace } from '@/api/types';
import { m } from '@/i18n';

const state = vi.hoisted(() => ({
  storage: null as null | { kind: string; short: string },
  workspaces: [] as Partial<Workspace>[],
}));
vi.mock('@/api/hooks', () => ({
  useWorkspaces: () => ({ data: state.workspaces }),
}));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  useStorageStatus: () => state.storage,
}));
// Each option as a row: its label, or its icon and name.
vi.mock('@/components/ui/Select', () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({
    children,
    iconAndValue,
  }: {
    children?: ReactNode;
    iconAndValue?: { label: string };
  }) => <p data-option>{iconAndValue?.label ?? children}</p>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const { AddFileDestination } = await import('./AddFileDestination');

const workspace = (id: string, name: string, canEdit: boolean) =>
  ({
    capabilities: { canEdit },
    iconId: 'books',
    id,
    name,
  }) as Partial<Workspace>;
const render = () =>
  renderToStaticMarkup(
    <AddFileDestination onChange={() => undefined} value={null} />
  );

afterEach(() => {
  state.storage = null;
});

// P3 (2026-10-27): No workspace first, then the workspaces the caller edits
// in the list's order.
it('offers No workspace, then the workspaces the caller edits', () => {
  state.workspaces = [
    workspace('ws_bio', 'Biology', true),
    workspace('ws_view', 'Shared reading', false),
    workspace('ws_chem', 'Chemistry', true),
  ];
  const options = [...render().matchAll(/<p data-option[^>]*>(.*?)<\/p>/g)].map(
    ([, html]) => html.replace(/<[^>]+>/g, '')
  );
  expect(options).toEqual([m.clone_no_workspace(), 'Biology', 'Chemistry']);
});

it('says why a frozen account cannot add', () => {
  state.storage = { kind: 'frozen-self', short: m.account_frozen_short() };
  expect(render()).toContain(m.account_frozen_short());
});
