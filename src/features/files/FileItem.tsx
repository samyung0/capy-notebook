import { memo, useContext, useState } from 'react';
import type { SourceFile, Workspace } from '@/api/types';
import { ItemCard, ItemPick, itemMenuIcon } from '@/components/app/ItemCard';
import type { ListView } from '@/components/app/ListToolbar';
import { fileCanClone, formatFileSize } from '@/features/files/fileUtils';
import { toastLostAccess } from '@/features/files/lostAccess';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { ContentActions } from '@/features/workspace/ContentActions';
import { toFileActionTarget } from '@/features/workspace/contentActionTarget';
import { AddSourceDialog } from '@/features/workspace/LazyAddSourceDialog';
import {
  type RetryProcessing,
  retryFailedFile,
} from '@/features/workspace/retryProcessing';
import { m } from '@/i18n';
import { fileIconName } from '@/lib/fileIcons';

/** A Files page row's menu, from the rights the server read with the page
 * (Epo 2026-10-28). */
export function fileRowActions(file: SourceFile) {
  return {
    canClone: fileCanClone(file) && !!file.rights?.clone,
    canMoveTo: !!file.rights?.move,
    canRename: !!file.rights?.rename,
    readOnly: !file.rights?.trash,
  };
}

/** A file the caller may delete from the Files page: one it pays for after
 * losing access, or one its rights let it trash. */
export const canDeleteFile = (file: SourceFile) =>
  file.lostAccess || !!file.rights?.trash;

/** One file in the Files page's list; memoised so a pick re-renders only the
 * cards whose selection changed. */
export const FileItem = memo(function FileItem({
  file,
  onDelete,
  pickKey,
  retry,
  retryPending,
  selected,
  view,
  workspace,
}: {
  file: SourceFile;
  pickKey: string;
  /** A file in a workspace the viewer lost access to can only be deleted. */
  onDelete: (files: SourceFile[]) => void;
  /** Retry processing of a failed standalone file (its owner is the viewer). */
  retry: RetryProcessing;
  retryPending: boolean;
  selected: boolean;
  view: ListView;
  workspace?: Workspace;
}) {
  const busy = !!useContext(ItemPick)?.busy;
  // No workspace: the viewer's own file, never shared on its own.
  const standalone = !file.workspaceId;
  const [retrying, setRetrying] = useState(false);
  return (
    <>
      <ItemCard
        actions={
          file.lostAccess ? (
            // Lost access: its payer may still copy, download and delete it
            // (Epo 2026-10-27, D3), never open or restore it in place.
            <ContentActions
              beforeDeleteItems={[
                {
                  danger: true,
                  disabled: busy,
                  icon: 'trash',
                  label: m.action_delete(),
                  onClick: () => onDelete([file]),
                },
              ]}
              canClone
              content={toFileActionTarget(file)}
              display="menu"
              menuAlign="end"
              menuTriggerIcon={itemMenuIcon(view)}
              readOnly
              topics={[]}
              workspaceId={file.workspaceId}
            />
          ) : (
            // The server reads what the caller may do with each row.
            <ContentActions
              {...fileRowActions(file)}
              content={toFileActionTarget(file)}
              display="menu"
              leadingItems={
                standalone && file.status === 'failed'
                  ? [
                      {
                        disabled: retryPending,
                        icon: 'refresh',
                        label: m.files_retry_processing(),
                        onClick: () =>
                          retryFailedFile(file, retry, () => setRetrying(true)),
                        warning: true,
                      },
                    ]
                  : []
              }
              menuAlign="end"
              menuTriggerIcon={itemMenuIcon(view)}
              renameFieldLabel={m.files_file_name()}
              renameTitle={m.files_rename()}
              showMove={false}
              topics={[]}
              workspaceId={file.workspaceId}
            />
          )
        }
        details={formatFileSize(file.sizeBytes)}
        icon={fileIconName(file)}
        link={
          file.lostAccess
            ? undefined
            : { params: { fileId: file.id }, to: '/files/$fileId' }
        }
        meta={relativeTime(file.addedAt)}
        onOpen={file.lostAccess ? toastLostAccess : undefined}
        pickKey={pickKey}
        selected={selected}
        thumbnail={{
          fileKind: file.kind,
          preview: file.preview,
          thumbnailUrl: file.thumbnailUrl,
        }}
        title={file.name}
        view={view}
        workspace={workspace?.name ?? file.workspaceName ?? ''}
        workspaceIconId={workspace?.iconId}
        workspaceLost={file.lostAccess}
      />
      {retrying && (
        <AddSourceDialog
          onClose={() => setRetrying(false)}
          open
          retryFile={file}
          workspaceId={null}
        />
      )}
    </>
  );
});
