import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type RefObject, useRef } from 'react';
import { useMaterial, useWorkspace } from '@/api/hooks';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { SimpleDialog } from '@/components/ui/Dialog';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { type CloneKind, cloneLabel, parseCloneTarget } from '@/lib/cloneLink';
import { errorCopy } from '@/lib/errors';
import { redeemShareToken } from '@/lib/shareRedeem';
import { clearStashedToken } from '@/lib/urlTokenStash';
import { useStashedToken } from '@/lib/useStashedToken';

/** The dashboard's `?clone=<kind>:<token>`, which public pages' Clone opens:
 * loads the item into its clone form (a workspace's prefilled form, an item's
 * destination and name), shows a refusal (a link viewer cloning a workspace,
 * a full plan) in it, and opens the copy. */
export function CloneLinkDialog() {
  const search = useSearch({ strict: false }) as { clone?: unknown };
  // A new link remounts it, reading its token afresh.
  return <CloneLink key={String(search.clone)} value={search.clone} />;
}

function CloneLink({ value }: { value: unknown }) {
  // The boot module moved the token out of the address bar (urlTokenStash).
  const target = parseCloneTarget(
    useStashedToken('clone', typeof value === 'string' ? value : '')
  );
  const navigate = useNavigate();
  // The dialog closes itself when the path changes; opening the copy must not
  // send the user back to the dashboard.
  const leaving = useRef(false);
  // A frozen account copies nothing; its canClone reads false everywhere, so
  // say why before the item-specific checks blame the workspace.
  const frozen = useAccountFrozen();
  // The link's token is presented once (Google's resource key, Sam
  // 2026-10-18), so the item then reads by id like any other.
  const { error: redeemError, isSuccess: redeemed } = useQuery({
    enabled: !!target && !frozen,
    meta: { errorBoundary: false },
    // Used or refused: it has no further use in this tab.
    queryFn: () =>
      redeemShareToken(target?.token ?? '').finally(() =>
        clearStashedToken('clone')
      ),
    queryKey: ['share-redeem', target?.token],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!target) return null;

  const close = () => {
    if (leaving.current) return;
    void navigate({ replace: true, search: {}, to: '/' });
  };

  if (frozen) {
    return (
      <SimpleDialog onClose={close} open title={cloneLabel(target.kind)}>
        <WarningBanner message={m.account_banner_frozen_body()} />
      </SimpleDialog>
    );
  }
  if (redeemError) {
    return (
      <SimpleDialog onClose={close} open title={cloneLabel(target.kind)}>
        <WarningBanner message={errorCopy(redeemError, m.source_try_again())} />
      </SimpleDialog>
    );
  }
  if (!redeemed) return null;
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
