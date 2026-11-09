/** A picture on the workspace canvas that plays by itself (Epo 2026-11-09): one of
 * Noto's animated emoji from our own files, or a GIF from KLIPY, kept as the link
 * KLIPY gave (its terms: shown from KLIPY, never copied). An uploaded GIF is an
 * ordinary image block. */
export type PictureKind = 'emoji' | 'klipy';

/** The emoji Misc offers: Noto Animated Emoji (Google, CC BY 4.0, credited on the
 * Credits page), resized to 96 px (moving) and 64 px (still) in public/emoji/noto. */
export const EMOJI = [
  '1f600',
  '1f602',
  '1f923',
  '1f60a',
  '1f60d',
  '1f929',
  '1f973',
  '1f60e',
  '1f913',
  '1f914',
  '1f9d0',
  '1f62e',
  '1f631',
  '1f62d',
  '1f622',
  '1f644',
  '1f971',
  '1f634',
  '1fae1',
  '1f917',
  '1fae0',
  '1f92f',
  '1f44d',
  '1f44e',
  '1f44f',
  '1f64c',
  '1f64f',
  '1f4aa',
  '1f44b',
  '2764_fe0f',
  '1f525',
  '1f4af',
  '2728',
  '2b50',
  '1f389',
  '2705',
  '274c',
  '1f4a1',
  '1f9e0',
  '1f4da',
  '1f3af',
  '1f680',
  '1f3c6',
  '1f947',
  '23f0',
  '1f4c8',
  '1f440',
  '1f308',
] as const;

/** An emoji's character, for its label. */
export const emojiText = (code: string) =>
  String.fromCodePoint(
    ...code.split('_').map((part) => Number.parseInt(part, 16))
  );

/** One of the emoji Misc offers, the only ones with files. */
export const isListedEmoji = (code: string) =>
  (EMOJI as readonly string[]).includes(code);

export const emojiUrl = (code: string) => `/emoji/noto/${code}.webp`;
/** Its first frame, small, for the picker: 48 moving ones would load ~5 MB. */
export const emojiStillUrl = (code: string) => `/emoji/noto/still/${code}.webp`;

/** An http(s) address: what a link card holds and opens. */
export const isWebAddress = (href: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(href).protocol);
  } catch {
    return false;
  }
};

/** KLIPY's media hosts, which the image policy also lists. */
export const KLIPY_MEDIA_HOSTS = [
  'static.klipy.com',
  'static1.klipy.com',
  'static2.klipy.com',
];

/** Where a KLIPY GIF may come from (its media hosts). */
export const isKlipyMedia = (url: string) => {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'https:' && KLIPY_MEDIA_HOSTS.includes(hostname);
  } catch {
    return false;
  }
};
