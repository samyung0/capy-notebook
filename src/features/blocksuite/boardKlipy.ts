import { isString, PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';
import { isKlipyMedia } from './boardPictureData';

/** KLIPY's GIF and sticker search for the workspace canvas (Epo 2026-11-09): called
 * from the student's browser and shown from KLIPY's links as its terms ask, results in
 * its order, with the strictest content filter. Its ads are off on the key. */

/** KLIPY's two kinds, the same API under each path (stickers come as PNG and WebP). */
export type KlipyKind = 'gifs' | 'stickers';

const KEY = import.meta.env.VITE_KLIPY_KEY as string | undefined;
const API = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;

export type KlipyGif = {
  id: string;
  /** KLIPY's name for it, which its share event takes. */
  slug: string;
  title: string;
  /** Shown in the picker. */
  preview: Rendition;
  /** Placed on the canvas, at its size when KLIPY gives one. */
  media: Rendition;
  /** KLIPY's blurred preview, a small inline JPEG shown while it loads. */
  blur?: string;
};

type Rendition = { height?: number; url: string; width?: number };
type Item = {
  id: number | string;
  slug: string;
  title?: string;
  blur_preview?: unknown;
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

/** One page of KLIPY's results and whether it has another. */
export type KlipyPage = { items: KlipyGif[]; more: boolean };

/** Trending when `query` is empty, else the search, of GIFs or stickers: page `page`
 * (from 1), which the picker loads one after another as it scrolls. */
export async function klipyMedia(
  kind: KlipyKind,
  query: string,
  page: number,
  signal: AbortSignal
): Promise<KlipyPage> {
  if (!KEY) return { items: [], more: false };
  const params = new URLSearchParams({
    content_filter: 'high',
    customer_id: customerId(),
    format_filter: 'webp',
    page: String(page),
    per_page: String(PER_PAGE),
  });
  const trimmed = query.trim();
  if (trimmed) params.set('q', trimmed);
  const route = trimmed ? 'search' : 'trending';
  const response = await fetch(
    `${API}/${encodeURIComponent(KEY)}/${kind}/${route}?${params}`,
    { signal }
  );
  if (!response.ok) throw new Error(`KLIPY ${response.status}`);
  const body = (await response.json()) as {
    data?: { data?: Item[]; has_next?: boolean };
  };
  // One from another host is left out; the rest keep KLIPY's order (its terms).
  const items = (body.data?.data ?? []).flatMap((item) => {
    const preview = webp(item, 'sm') ?? webp(item, 'md');
    const media = webp(item, 'md') ?? preview;
    return preview && media
      ? [
          {
            blur:
              typeof item.blur_preview === 'string' &&
              item.blur_preview.startsWith('data:image/')
                ? item.blur_preview
                : undefined,
            id: String(item.id),
            media,
            preview,
            slug: typeof item.slug === 'string' ? item.slug : '',
            title:
              typeof item.title === 'string'
                ? item.title
                : typeof item.slug === 'string'
                  ? item.slug
                  : '',
          },
        ]
      : [];
  });
  return { items, more: body.data?.has_next === true };
}

/** Tells KLIPY one was placed (its share event, for its ranking), with the search
 * that found it or none from trending. Nothing waits on it and a failure is
 * dropped: the board already has the picture. */
export function klipyShared(kind: KlipyKind, gif: KlipyGif, query: string) {
  if (!(KEY && gif.slug)) return;
  fetch(
    `${API}/${encodeURIComponent(KEY)}/${kind}/share/${encodeURIComponent(gif.slug)}`,
    {
      body: JSON.stringify({ customer_id: customerId(), q: query.trim() }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }
  ).catch(() => {});
}
