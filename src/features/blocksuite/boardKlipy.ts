import { BOARD_CATALOG } from '@/api/board.generated';
import { isString, PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';
import { isKlipyMedia } from './boardPictureData';

/** KLIPY's GIF search for the workspace canvas (Epo 2026-11-09): called from the
 * student's browser and shown from KLIPY's links as its terms ask, results in its
 * order, with the strictest content filter. Its ads are off on the key. */

const KEY = import.meta.env.VITE_KLIPY_KEY as string | undefined;
const API = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;

export type KlipyGif = {
  id: string;
  title: string;
  /** Shown in the picker. */
  preview: { height: number; url: string; width: number };
  /** Placed on the canvas. */
  media: { height: number; url: string; width: number };
};

type Rendition = { height: number; url: string; width: number };
type Item = {
  id: number | string;
  slug: string;
  title?: string;
  file?: Record<string, Record<string, Rendition | undefined> | undefined>;
};

export const klipyEnabled = () => !!KEY;

/** The same anonymous id for this browser, as KLIPY asks per user: not the account. */
function customerId() {
  const kept = readPref(PREF_KEYS.klipyCustomer, '', isString);
  if (kept) return kept;
  const made = crypto.randomUUID();
  writePref(PREF_KEYS.klipyCustomer, made);
  return made;
}

/** A rendition the canvas can keep: from KLIPY's media hosts, within the picture
 * link's limit and with a size, as the board's load check asks. */
const fits = (rendition: Rendition | undefined) =>
  rendition &&
  isKlipyMedia(rendition.url) &&
  rendition.url.length <= BOARD_CATALOG.limits.PICTURE_REF_MAX &&
  Number.isFinite(rendition.width) &&
  rendition.width > 0 &&
  Number.isFinite(rendition.height) &&
  rendition.height > 0
    ? rendition
    : undefined;

const webp = (item: Item, size: string) => fits(item.file?.[size]?.webp);

/** Trending when `query` is empty, else the search's first page. */
export async function klipyGifs(
  query: string,
  signal: AbortSignal
): Promise<KlipyGif[]> {
  if (!KEY) return [];
  const params = new URLSearchParams({
    content_filter: 'high',
    customer_id: customerId(),
    format_filter: 'webp',
    page: '1',
    per_page: String(PER_PAGE),
  });
  const trimmed = query.trim();
  if (trimmed) params.set('q', trimmed);
  const route = trimmed ? 'search' : 'trending';
  const response = await fetch(
    `${API}/${encodeURIComponent(KEY)}/gifs/${route}?${params}`,
    { signal }
  );
  if (!response.ok) throw new Error(`KLIPY ${response.status}`);
  const body = (await response.json()) as { data?: { data?: Item[] } };
  // One that doesn't fit is left out; the rest keep KLIPY's order (its terms).
  return (body.data?.data ?? []).flatMap((item) => {
    const preview = webp(item, 'sm') ?? webp(item, 'md');
    const media = webp(item, 'md') ?? preview;
    return preview && media
      ? [
          {
            id: String(item.id),
            media,
            preview,
            title: item.title ?? item.slug,
          },
        ]
      : [];
  });
}
