import type { BoardView } from '@/features/blocksuite/drawingBoard';
import { PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';

/**
 * Where the person last looked at each canvas on this device (Epo 2026-11-19,
 * Q32): the next open shows that view, and only a first open on the device
 * fits everything. Kept with the account it belongs to, as the Make a quiz
 * runs are (savedForAccount.ts): claimed when the account is known
 * (`claimCanvasViews`), so another account's views, or anyone's once signed
 * out, are dropped.
 */
interface StoredViews {
  owner: string | null;
  /** By canvas id, the latest written last. */
  views: Record<string, BoardView>;
}

/** The canvases whose view is kept; past it the longest unopened goes. */
const KEPT_MAX = 100;

function isView(value: unknown): value is BoardView {
  if (typeof value !== 'object' || value === null) return false;
  const { centre, zoom } = value as Partial<BoardView>;
  return (
    typeof zoom === 'number' &&
    zoom > 0 &&
    Array.isArray(centre) &&
    centre.length === 2 &&
    centre.every(Number.isFinite)
  );
}

function isStoredViews(value: unknown): value is StoredViews {
  if (typeof value !== 'object' || value === null) return false;
  const { owner, views } = value as Partial<StoredViews>;
  return (
    (owner === null || typeof owner === 'string') &&
    typeof views === 'object' &&
    views !== null &&
    Object.values(views).every(isView)
  );
}

const readStored = () => readPref(PREF_KEYS.canvasViews, null, isStoredViews);

/** The account the views are kept for: the claimed one, else the stored
 * record's (the mock app claims none). */
let owner = readStored()?.owner ?? null;

/** The views stored for `owner`, none for another account's record. */
const ownViews = () => {
  const stored = readStored();
  return stored?.owner === owner ? stored.views : {};
};

/** Runs when the signed-in account is known (`claimAccountData`). */
export function claimCanvasViews(next: string | null): void {
  owner = next;
  if (readStored()?.owner !== next)
    writePref(PREF_KEYS.canvasViews, { owner: next, views: {} });
}

/** The view kept for canvas `id`; none on a first open on this device. */
export function keptView(id: string): BoardView | undefined {
  const views = ownViews();
  return Object.hasOwn(views, id) ? views[id] : undefined;
}

/** Keeps `view` as canvas `id`'s last view for the claimed account. */
export function keepView(id: string, view: BoardView | null): void {
  if (!view) return;
  const { [id]: _, ...others } = ownViews();
  const views = Object.entries({ ...others, [id]: view }).slice(-KEPT_MAX);
  writePref(PREF_KEYS.canvasViews, {
    owner,
    views: Object.fromEntries(views),
  });
}

/** Keeps `board`'s view of canvas `id` whenever the page is hidden (another
 * tab, a reload, the tab closed: no unmount runs then) and when the returned
 * function runs, as the board unmounts. */
export function keepViewOf(
  id: string,
  board: { view: () => BoardView | null }
): () => void {
  const keep = () => keepView(id, board.view());
  const hidden = () => {
    if (document.visibilityState === 'hidden') keep();
  };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', keep);
  return () => {
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', keep);
    keep();
  };
}
