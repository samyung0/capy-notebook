/**
 * Whether the PPTX editor shows its speaker notes: one choice per person,
 * kept in this browser for every presentation. Storage can be missing or
 * blocked (private windows, storage access denied); the notes then start hidden.
 */
const KEY = 'capy.pptx.speakerNotes';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Even reading `localStorage` throws when the browser blocks it, so callers
// get it lazily inside their try.
const browserStorage = (): Store => localStorage;

export function readSpeakerNotes(
  storage: () => Store = browserStorage
): boolean {
  try {
    return storage().getItem(KEY) === 'shown';
  } catch {
    return false;
  }
}

export function writeSpeakerNotes(
  visible: boolean,
  storage: () => Store = browserStorage
): void {
  try {
    storage().setItem(KEY, visible ? 'shown' : 'hidden');
  } catch {
    // Not remembered; the next open starts hidden.
  }
}
