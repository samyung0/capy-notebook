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
  preview: Rendition;
  /** Placed on the canvas, at its size when KLIPY gives one. */
  media: Rendition;
};

type Rendition = { height?: number; url: string; width?: number };
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

/** A rendition from KLIPY's own hosts, the only check (Epo 2026-11-09): its terms
 * forbid removing results, so length and size never drop one. */
const fits = (rendition: Rendition | undefined) =>
  rendition && typeof rendition.url === 'string' && isKlipyMedia(rendition.url)
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
  // One from another host is left out; the rest keep KLIPY's order (its terms).
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
