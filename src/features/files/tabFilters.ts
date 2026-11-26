import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useWorkspaces } from '@/api/hooks';
import type { FileKind } from '@/api/types';
import { type FilterSection, toggleValue } from '@/components/app/ListToolbar';
import { fileKindLabel } from '@/features/files/fileKindLabel';
import { materialKindLabel } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import {
  csv,
  FILE_KINDS,
  type FilesSearch,
  TRASH_KINDS,
  tabFilterParams,
} from '@/lib/listSearch';

/** Trash's and Canvas's filters (Epo 2026-11-26): the Files list's Kind
 * (Trash only), Location and Workspace sections, in the URL as Files keeps
 * them. `kinds` adds the Kind section. Returns the toolbar's sections, its
 * reset, the list's query and whether any filter is on. */
export function useTabFilters({ kinds = false }: { kinds?: boolean } = {}) {
  const search = useSearch({ from: '/auth-shell/files' });
  const navigate = useNavigate({ from: '/files' });
  const setSearch = (patch: FilesSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const params = useMemo(() => tabFilterParams(search), [search]);
  const picked = params.kinds ?? [];
  const workspaceIds = params.workspaceIds ?? [];
  const { location } = search;
  const filters: FilterSection[] = [
    ...(kinds
      ? [
          {
            key: 'kind',
            label: m.files_filter_kind(),
            onToggle: (value: string) =>
              setSearch({ kind: csv(toggleValue(picked, value)) }),
            options: TRASH_KINDS.map((kind) => ({
              label: (FILE_KINDS as readonly string[]).includes(kind)
                ? fileKindLabel(kind as FileKind)
                : materialKindLabel(kind as Exclude<typeof kind, FileKind>),
              value: kind,
            })),
            selected: picked,
          },
        ]
      : []),
    {
      key: 'location',
      label: m.create_filter_location(),
      onToggle: () =>
        setSearch({
          location: location === 'workspace' ? undefined : 'workspace',
        }),
      options: [{ label: m.files_location_workspace(), value: 'workspace' }],
      selected: location === 'workspace' ? ['workspace'] : [],
    },
    {
      emptyLabel: m.common_nothing_yet(),
      key: 'workspace',
      label: m.files_filter_workspace(),
      onToggle: (value) =>
        setSearch({ workspace: csv(toggleValue(workspaceIds, value)) }),
      options: workspaces.map((ws) => ({ label: ws.name, value: ws.id })),
      selected: workspaceIds,
    },
  ];
  return {
    filtered: picked.length > 0 || workspaceIds.length > 0 || !!location,
    filters,
    params,
    reset: () =>
      setSearch({ kind: undefined, location: undefined, workspace: undefined }),
    workspaces,
  };
}
