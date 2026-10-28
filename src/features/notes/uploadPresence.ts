import { CursorEditor } from '@slate-yjs/core';
import { useCallback, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import {
  MAX_UPLOAD_ID,
  MAX_UPLOADS,
  readNotePresence,
  setNotePresence,
} from './notePresence';

/**
 * Uploads in presence (Epo, 2026-10-10): a tab names the placeholder blocks it
 * is uploading into in its awareness, by node id, and every other client in
 * the room shows those blocks as the uploading skeleton while that tab stays
 * connected. Nothing about an upload is stored in the note: when the uploader
 * leaves or its awareness times out, the block is the empty placeholder again.
 *
 * Size: a placeholder id is a 21-character nanoid. A tab names at most 100
 * uploads of at most 32 characters, the note's field list (notePresence.ts),
 * under 3.5 KiB of the room's 4 KiB awareness state (pasted images upload four
 * at a time, so the rest wait unnamed, as empty placeholders for the others);
 * a state past those bounds is dropped whole, by the room and by receivers
 * (REVIEW5 E1, E3; Epo 2026-10-28).
 */

/** The editor's room presence, when it has one (a collaborative editor). */
export function editorAwareness(editor: unknown): Awareness | null {
  return CursorEditor.isCursorEditor(editor as never)
    ? (editor as CursorEditor).awareness
    : null;
}

const listed = (state: unknown) => readNotePresence(state)?.uploads ?? [];

/** Names `id` as an upload in this client's awareness until the returned
 * function runs (the upload finished, failed or was cancelled); past 100
 * named uploads, or for an id the room would refuse, not at all. */
export function announceUpload(awareness: Awareness | null, id: string) {
  const named = awareness ? listed(awareness.getLocalState()) : [];
  if (
    !awareness ||
    id.length > MAX_UPLOAD_ID ||
    (named.length >= MAX_UPLOADS && !named.includes(id))
  )
    return () => undefined;
  if (!named.includes(id))
    setNotePresence(awareness, { uploads: [...named, id] });
  return () => {
    const rest = listed(awareness.getLocalState()).filter(
      (other) => other !== id
    );
    setNotePresence(awareness, { uploads: rest.length ? rest : undefined });
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
