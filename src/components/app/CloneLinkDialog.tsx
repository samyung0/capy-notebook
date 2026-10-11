import { useNavigate, useSearch } from '@tanstack/react-router';
import { type RefObject, useRef } from 'react';
import { useMaterial, useWorkspace } from '@/api/hooks';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { SimpleDialog } from '@/components/ui/Dialog';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { m } from '@/i18n';
import { type CloneKind, cloneLabel, parseCloneTarget } from '@/lib/cloneLink';
import { errorCopy } from '@/lib/errors';

/** The dashboard's `?clone=<kind>:<id>`, which public pages' Clone opens:
 * loads the item into its clone form (a workspace's prefilled form, an item's
 * destination and name), shows a refusal (a link viewer cloning a workspace,
 * a full plan) in it, and opens the copy. */
export function CloneLinkDialog() {
  const search = useSearch({ strict: false }) as { clone?: unknown };
  const target = parseCloneTarget(search.clone);
  const navigate = useNavigate();
  // The dialog closes itself when the path changes; opening the copy must not
  // send the user back to the dashboard.
  const leaving = useRef(false);
  if (!target) return null;

  const close = () => {
    if (leaving.current) return;
    void navigate({ replace: true, search: {}, to: '/' });
  };

  if (target.kind === 'workspace') {
    return (
      <WorkspaceCloneLink id={target.id} leaving={leaving} onClose={close} />
    );
  }
  return (
    <ItemCloneLink
      id={target.id}
      kind={target.kind}
      leaving={leaving}
      onClose={close}
    />
  );
}

/** Loads the quiz, flashcards or note to prefill its clone form; a reader who
 * cannot read it, or may not copy it (a link viewer of its workspace, or an
 * item embedded in a note), sees why instead. */
function ItemCloneLink({
  id,
  kind,
  leaving,
  onClose,
}: {
  id: string;
  kind: CloneKind;
  leaving: RefObject<boolean>;
  onClose: () => void;
}) {
  const { data: material, error } = useMaterial(id, { errorBoundary: false });
  // In a workspace only its members and editors clone (canClone).
  const { data: workspace, error: workspaceError } = useWorkspace(
    material?.workspaceId ?? '',
    { errorBoundary: false }
  );
  const refusal = material?.parentMaterialId
    ? m.clone_embedded_not_allowed()
    : workspace && !workspace.canClone
      ? m.clone_item_not_allowed()
      : null;
  if (material && !refusal && (!material.workspaceId || workspace)) {
    return (
      <CloneItemDialog
        item={{
          id: material.id,
          kind: material.kind,
          name: material.title,
          type: 'material',
          workspaceId: material.workspaceId,
        }}
        onCloned={() => {
          leaving.current = true;
        }}
        onClose={onClose}
      />
    );
  }
  const failed = error ?? workspaceError;
  if (!(refusal || failed)) return null;
  return (
    <SimpleDialog onClose={onClose} open title={cloneLabel(kind)}>
      <WarningBanner
        message={refusal ?? errorCopy(failed, m.source_try_again())}
      />
    </SimpleDialog>
  );
}

/** Loads the workspace to prefill the clone form; a reader who may not clone
 * (a link viewer) or cannot read it sees why instead. */
function WorkspaceCloneLink({
  id,
  leaving,
  onClose,
}: {
  id: string;
  leaving: RefObject<boolean>;
  onClose: () => void;
}) {
  const { data: workspace, error } = useWorkspace(id, { errorBoundary: false });
  if (workspace?.canClone) {
    return (
      <CloneWorkspaceDialog
        onCloned={() => {
          leaving.current = true;
        }}
        open
        setOpen={(open) => !open && onClose()}
        workspace={workspace}
      />
    );
  }
  if (!workspace && !error) return null;
  return (
    <SimpleDialog onClose={onClose} open title={m.action_clone_workspace()}>
      <WarningBanner
        message={
          workspace
            ? m.clone_workspace_not_allowed()
            : errorCopy(error, m.source_try_again())
        }
      />
    </SimpleDialog>
  );
}
