/**
 * View toggles one person keeps in this browser for every file of a format:
 * PPTX speaker notes and the DOCX rulers. Storage can be missing or blocked
 * (private windows, storage access denied); a toggle then starts off.
 */
const KEYS = {
  docxRuler: 'capy.docx.ruler',
  speakerNotes: 'capy.pptx.speakerNotes',
} as const;

export type ViewToggle = keyof typeof KEYS;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Even reading `localStorage` throws when the browser blocks it, so callers
// get it lazily inside their try.
const browserStorage = (): Store => localStorage;

export function readViewToggle(
  toggle: ViewToggle,
  storage: () => Store = browserStorage
): boolean {
  try {
    return storage().getItem(KEYS[toggle]) === 'shown';
  } catch {
    return false;
  }
}

export function writeViewToggle(
  toggle: ViewToggle,
  shown: boolean,
  storage: () => Store = browserStorage
): void {
  try {
    storage().setItem(KEYS[toggle], shown ? 'shown' : 'hidden');
  } catch {
    // Not remembered; the next open starts off.
  }
}
