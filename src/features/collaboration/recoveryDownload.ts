import type * as Y from 'yjs';
import type { DeletedItem } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/* The recovery strip's Download, which quizzes and sets embedded on a drawing
 * board reach. Rule: nothing the board reaches may import the file writers
 * (`deletedEditsFile`), nor `deletedEditsToast`, which loads them: tsc follows a
 * dynamic import too, so the board's check (scripts/typecheck-board.mjs) would
 * take in the note exporters and their @types/hast, newer than the one
 * vendored BlockSuite pins. So the app's entry (main.tsx), which the board
 * never reaches, hands the writer in; its type is written here by hand, as
 * `typeof import(...)` would take the file in as well. */

/** Saves the file of what an open item's recovery shows, from its documents as
 * drawn (`saveRecoveryFile`). */
type RecoveryWriter = (
  item: DeletedItem,
  content: Y.Doc | null,
  keys: Y.Doc | null
) => Promise<void>;

let loadWriter: (() => Promise<RecoveryWriter>) | undefined;

/** Called once by the app's entry (main.tsx). */
export function provideRecoveryWriter(load: () => Promise<RecoveryWriter>) {
  loadWriter = load;
}

/** The recovery strip's Download on an item's page (refused, moved on:
 * Epo 2026-11-23): the file of what it shows, made from its documents as
 * drawn (`content`, and a quiz's `keys`), deleting nothing. Without a writer
 * handed in, it fails as a file that could not be made. */
export async function downloadRecovery(
  item: DeletedItem,
  content: Y.Doc | null,
  keys: Y.Doc | null = null
) {
  try {
    if (!loadWriter) throw new Error('No recovery writer was provided');
    const save = await loadWriter();
    await save(item, content, keys);
  } catch (error) {
    console.error(error);
    userToast({ title: m.lost_edits_download_failed(), variant: 'error' });
  }
}
