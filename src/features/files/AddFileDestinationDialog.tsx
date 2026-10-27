import { useWorkspaces } from '@/api/hooks';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { useStorageStatus } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';

const ROW = cn(
  BASE_BUTTON_STYLE,
  'flex items-center gap-3 px-1.5 py-1.5 text-left hover:bg-surface-hover-bg disabled:pointer-events-none disabled:opacity-50'
);

/** Where the Files tab's Add file puts its files: No workspace first, then
 * the workspaces the caller edits, most recently opened first (P3,
 * 2026-10-27). A frozen or full account sees the rows off, with the reason.
 * The plain dialog with no footer (Epo 2026-10-27). `onPick` gets null for
 * No workspace. */
export function AddFileDestinationDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (workspaceId: string | null) => void;
}) {
  const { data: workspaces, isLoading } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const editable = (workspaces ?? []).filter((ws) => ws.capabilities.canEdit);
  // What the caller adds is charged to them, so their own account refuses it.
  const status = useStorageStatus();
  const blocked = status?.kind === 'frozen-self' || status?.kind === 'full';
  return (
    <SimpleDialog
      className="max-w-md"
      onClose={onClose}
      open
      title={m.files_add_destination_title()}
    >
      {blocked && (
        <p className="t-meta pb-3 text-tint-error-fg" role="note">
          {status.short}
        </p>
      )}
      <div className="-mx-1.5 flex flex-col gap-1">
        <button
          className={ROW}
          disabled={blocked}
          onClick={() => onPick(null)}
          type="button"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-surface-hover-bg text-fg-secondary">
            <Icon className="size-4.5" name="filesNav" />
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">
            {m.clone_no_workspace()}
          </span>
        </button>
        {isLoading ? (
          <SkeletonList count={3} rowHeight={44} />
        ) : (
          editable.map((workspace) => (
            <button
              className={ROW}
              disabled={blocked}
              key={workspace.id}
              onClick={() => onPick(workspace.id)}
              type="button"
            >
              <img
                alt=""
                className="size-8 shrink-0 rounded-[6px]"
                height={32}
                src={iconUrl(workspace.iconId)}
                width={32}
              />
              <span className="min-w-0 flex-1 truncate font-semibold text-fg">
                {workspace.name}
              </span>
            </button>
          ))
        )}
      </div>
    </SimpleDialog>
  );
}
