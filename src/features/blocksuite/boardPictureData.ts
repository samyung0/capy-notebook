// Relative: vite-image-policy.ts loads this file with the Vite config, before aliases.
import { BOARD_CATALOG } from '../../api/board.generated';

/** A picture on the workspace canvas that plays by itself (Epo 2026-11-09): one of
 * Noto's animated emoji from our own files, or a GIF from KLIPY, kept as the link
 * KLIPY gave (its terms: shown from KLIPY, never copied). An uploaded GIF is an
 * ordinary image block. */
export type PictureKind = 'emoji' | 'klipy';

/** The emoji Misc offers: Noto Animated Emoji (Google, CC BY 4.0, credited on the
 * Credits page), resized to 96 px (moving) and 64 px (still) in public/emoji/noto. The
 * board catalog lists them, so the canvas room checks a picture against the same list. */
export const EMOJI = BOARD_CATALOG.emoji;

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

/** Where KLIPY serves media: any https *.klipy.com host (Epo 2026-11-09), as the
 * image policy allows. */
export const KLIPY_MEDIA_SOURCE = 'https://*.klipy.com';

/** Where a KLIPY GIF may come from (its media hosts). */
export const isKlipyMedia = (url: string) => {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'https:' && hostname.endsWith('.klipy.com');
  } catch {
    return false;
  }
};
