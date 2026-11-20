import { hashKey, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isApiError, qk } from '@/api/client';
import { freshAnswer } from '@/api/queryClient';
import { hasToast, userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { markItemWorking, takeItemWorking, watchItem } from './roomRefusals';

/** A read the server refused. A rate limit, a timeout or a server error says
 * nothing about the item: such a read could not answer. */
export const isRefusedRead = (error: unknown) =>
  isApiError(error) &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

/** A read refusing this person the item (forbidden, or the non-disclosing
 * not found): what being kicked reads as. Deleted (410), a conflict, an
 * undecodable item or a lapsed session (401) is no lost access. */
export const isAccessRefused = (error: unknown) =>
  isApiError(error) && (error.status === 403 || error.status === 404);

/** The one "You no longer have access" toast (Epo 2026-11-20), for an item or
 * a workspace: one already showing or waiting its turn is left as it is, since
 * firing it again would count it up (×2). */
export function toastAccessLost() {
  if (hasToast('access-lost')) return;
  userToast({
    id: 'access-lost',
    title: m.editor_access_lost(),
    variant: 'error',
  });
}

/** An answer showing the item live. A trashed one (its payer's or the
 * workspace owner's read of an item another member trashed) is no sign it
 * worked here: its purge is a deletion, never lost access. */
const liveAnswer = (data: unknown) =>
  !(typeof data === 'object' && data !== null && 'trash' in data && data.trash);

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
 * Kicked (Epo 2026-11-20): the item this page shows worked here (a room of it
 * synced, `markItemWorking`, or the page's `read` answered a fetch), then the
 * page's read `refused` the person access (`isAccessRefused`), whether a
 * room's refusal asked for that read or a list dropping the item did. The
 * page says it is unavailable as any refusal, with an error toast saying they
 * lost access, once per item, and the lists showing the item read again: no
 * tree event tells them it went. An item simply opened unavailable, a stale
 * or restored copy painted before its read refused included, says nothing
 * more. All access-lost toasts share one id, so a workspace's and an item's
 * replace each other.
 */
export function useAccessLostNotice(
  file: boolean,
  id: string | undefined,
  {
    read,
    refused,
    workspaceId,
  }: {
    /** The page's read of the item: a fetch of it answering the item live
     * while the page shows it, or in the seconds before it opened, marks it.
     * A cache write is no answer, nor a trashed item. */
    read?: QueryKey;
    refused: boolean;
    workspaceId: string | null | undefined;
  }
) {
  const queryClient = useQueryClient();
  const readHash = read && hashKey(read);
  useEffect(() => {
    if (!id) return;
    const release = watchItem(file, id);
    if (!readHash) return release;
    const cache = queryClient.getQueryCache();
    const opened = cache.get<unknown, unknown>(readHash);
    if (freshAnswer(opened) && liveAnswer(opened?.state.data))
      markItemWorking(file, id);
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        !event.action.manual &&
        event.query.queryHash === readHash &&
        liveAnswer(event.action.data)
      )
        markItemWorking(file, id);
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [file, id, readHash, queryClient]);
  useEffect(() => {
    if (!(refused && id && takeItemWorking(file, id))) return;
    toastAccessLost();
    for (const queryKey of itemListKeys(file, workspaceId))
      void queryClient.invalidateQueries({ queryKey });
  }, [file, id, refused, workspaceId, queryClient]);
}
