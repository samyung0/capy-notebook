import { CursorEditor } from '@slate-yjs/core';
import { useCallback, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/**
 * Uploads in presence (Epo, 2026-10-10): a tab names the placeholder blocks it
 * is uploading into in its awareness, by node id, and every other client in
 * the room shows those blocks as the uploading skeleton while that tab stays
 * connected. Nothing about an upload is stored in the note: when the uploader
 * leaves or its awareness times out, the block is the empty placeholder again.
 *
 * Size: an id is at most 21 characters, ~24 bytes of the server's 64 KiB
 * awareness entry, which the room refuses past (closing the channel). A tab
 * names at most 100 uploads, under 3 KiB (pasted images upload four at a time,
 * so the rest wait unnamed, as empty placeholders for the others); a list a
 * client receives counts only its first 100 ids of up to 32 characters, so a
 * hostile list costs no more to scan (REVIEW5 E1, E3).
 */
const UPLOADS = 'uploads';
const MAX_UPLOADS = 100;
const MAX_ID = 32;

/** The editor's room presence, when it has one (a collaborative editor). */
export function editorAwareness(editor: unknown): Awareness | null {
  return CursorEditor.isCursorEditor(editor as never)
    ? (editor as CursorEditor).awareness
    : null;
}

function listed(state: unknown): string[] {
  const uploads = (state as Record<string, unknown> | null)?.[UPLOADS];
  if (!Array.isArray(uploads)) return [];
  return uploads
    .slice(0, MAX_UPLOADS)
    .filter(
      (id): id is string => typeof id === 'string' && id.length <= MAX_ID
    );
}

/** Names `id` as an upload in this client's awareness until the returned
 * function runs (the upload finished, failed or was cancelled); past 100
 * named uploads, not at all. */
export function announceUpload(awareness: Awareness | null, id: string) {
  const named = awareness ? listed(awareness.getLocalState()) : [];
  if (!awareness || (named.length >= MAX_UPLOADS && !named.includes(id)))
    return () => undefined;
  if (!named.includes(id))
    awareness.setLocalStateField(UPLOADS, [...named, id]);
  return () => {
    const rest = listed(awareness.getLocalState()).filter(
      (other) => other !== id
    );
    awareness.setLocalStateField(UPLOADS, rest.length ? rest : undefined);
  };
}

/** Whether a client other than `self` names `id` as an upload. */
export function uploadingElsewhere(
  states: Map<number, unknown>,
  self: number,
  id: string
) {
  for (const [client, state] of states)
    if (client !== self && listed(state).includes(id)) return true;
  return false;
}

/** `uploadingElsewhere` for one block: it re-renders only when its own
 * answer changes, not on every presence change in the room. */
export function useUploadingElsewhere(awareness: Awareness | null, id: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      awareness?.on('change', notify);
      return () => awareness?.off('change', notify);
    },
    [awareness]
  );
  const read = useCallback(
    () =>
      !!awareness &&
      uploadingElsewhere(awareness.getStates(), awareness.clientID, id),
    [awareness, id]
  );
  return useSyncExternalStore(subscribe, read, read);
}
