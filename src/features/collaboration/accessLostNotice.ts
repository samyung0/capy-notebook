import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isApiError, qk } from '@/api/client';
import { shownToasts, userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { takeRoomRefusal, watchRoomRefusals } from './roomRefusals';

/** A read the server refused. A rate limit, a timeout or a server error says
 * nothing about the item: such a read could not answer. */
export const isRefusedRead = (error: unknown) =>
  isApiError(error) &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

/** The one "You no longer have access" toast (Epo 2026-11-20), for an item or
 * a workspace: one already showing is left as it is, since firing it again
 * would count it up (×2). */
export function toastAccessLost() {
  if (shownToasts().error?.id === 'access-lost') return;
  userToast({
    id: 'access-lost',
    title: m.editor_access_lost(),
    variant: 'error',
  });
}

/** The lists showing an item: its workspace's tree, the Files page, Recent,
 * and a material's block, canvas, Study and Continue lists. */
export function itemListKeys(
  file: boolean,
  workspaceId: string | null | undefined
): QueryKey[] {
  if (file)
    return [
      ...(workspaceId ? [qk.files(workspaceId)] : []),
      qk.ownedFilesRoot,
      qk.recent,
    ];
  return [
    ...(workspaceId ? [qk.materials(workspaceId), qk.study(workspaceId)] : []),
    qk.itemsRoot,
    qk.ownedMaterialsRoot,
    qk.canvases,
    qk.continueRoot,
    qk.recent,
  ];
}

/**
 * Kicked (Epo 2026-11-20): a room of the item this page shows refused the
 * person (`markRoomRefusal`), then the page's read did too (`refused`, not
 * deleted). The page says it is unavailable as any refusal, with an error toast
 * saying they lost access, once per item, and the lists showing the item read
 * again: no tree event tells them it went. An item simply opened unavailable
 * says nothing more. All access-lost toasts share one id, so a workspace's and
 * an item's replace each other.
 */
export function useAccessLostNotice(
  file: boolean,
  id: string,
  refused: boolean,
  workspaceId: string | null | undefined
) {
  const queryClient = useQueryClient();
  useEffect(() => watchRoomRefusals(file, id), [file, id]);
  useEffect(() => {
    if (!(refused && takeRoomRefusal(file, id))) return;
    toastAccessLost();
    for (const queryKey of itemListKeys(file, workspaceId))
      void queryClient.invalidateQueries({ queryKey });
  }, [file, id, refused, workspaceId, queryClient]);
}
