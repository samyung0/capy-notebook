import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useFile, useMaterial, useWorkspace } from '@/api/hooks';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { PhoneTopRow } from '@/components/app/Sidebar';
import { IconButton } from '@/components/ui/IconButton';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { CenterContent } from '@/features/materials/CenterContent';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { waitsForConnection } from '@/lib/online';

/** Library items retain their ownership; this route only changes their frame. */
export default function MaterialOpen() {
  const { materialId, fileId } = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const materialQuery = useMaterial(materialId ?? null, {
    errorBoundary: false,
  });
  const fileQuery = useFile(fileId ?? null, { errorBoundary: false });
  const { data, fetchStatus, isError, isPending } = fileId
    ? fileQuery
    : materialQuery;
  const workspaceId = data?.workspaceId ?? '';
  const { data: workspace } = useWorkspace(workspaceId, {
    errorBoundary: false,
  });
  const frozen = useAccountFrozen();
  // A standalone file (no workspace) opens only for its owner, who edits it
  // unless their account is frozen.
  const fileReadOnly = workspaceId
    ? workspace?.capabilities.canEdit !== true
    : frozen;
  const back = () =>
    navigate({ search: fileId ? {} : { tab: 'blocks' }, to: '/files' });
  const item = fileId
    ? { id: fileId, kind: 'file' as const }
    : materialId
      ? { id: materialId, kind: 'material' as const }
      : null;

  // The document owns the full frame and its header's back button is the way
  // out; the sidebar or rail carries the nav from sm, and phones get the nav
  // drawer's menu button above the panel.
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <PhoneTopRow className="shrink-0 px-1 pt-1 pb-2" />
      <Panel frost="center" sectionClassName="h-full gap-0">
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isPending ? (
          <FileLoading />
        ) : isError || !data ? (
          <FileError />
        ) : (
          <CenterContent
            chapters={[]}
            item={item}
            key={`${item?.kind}:${item?.id}`}
            leading={
              <IconButton
                icon="navigationBack"
                iconClassName="-translate-y-px"
                label={fileId ? m.nav_files() : m.files_tab_blocks()}
                onClick={back}
                size="sm"
                tooltip
                variant="ghost-hover"
              />
            }
            onDeleted={back}
            onModeChange={(mode) => {
              void navigate({
                // The viewer has already completed its save/export checks.
                ignoreBlocker: true,
                replace: true,
                search: (previous) => ({ ...previous, mode }),
                to: '.',
              });
            }}
            readOnly={fileId ? fileReadOnly : false}
            requestedMode={'mode' in search ? search.mode : null}
            standalone
            workspaceId={workspaceId}
          />
        )}
      </Panel>
    </div>
  );
}
