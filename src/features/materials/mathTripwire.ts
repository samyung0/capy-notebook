/** A tripwire over MathLive's static markup, for the share pages that drop it
 * into the DOM without a sanitizer. `inertTex` keeps the known commands from
 * reaching an event handler or a paint/background URL, and this is the backstop
 * for anything it does not: a formula whose markup carries an inline event
 * handler, or a `url()`/`image-set()` paint or background, is not rendered.
 * Ordinary math markup carries neither, so this never fires on it. It does not
 * police every attribute (that would need a parser); the app's default-src CSP,
 * once enforced, is what governs SVG paint across the page. */

/** An element with an `on…=` inline event handler. */
const EVENT_HANDLER = /<[^>]*\son[a-z]+\s*=/i;
/** A paint server or background fetch. */
const FETCH = /url\s*\(|image-set\s*\(/i;
/** HTML character references, so an escaped `(` or letter cannot hide the
 * patterns above. */
const CHAR_REFERENCE = /&#x([0-9a-f]+);?|&#(\d+);?/gi;
const NAMED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['#40', '('],
  ['lpar', '('],
]);
const NAMED_REFERENCE = /&(amp|lt|gt|quot|apos|lpar);?/gi;

/** True when MathLive's markup carries an event handler or a fetch. */
export function markupIsInert(markup: string): boolean {
  const decoded = markup
    .replace(CHAR_REFERENCE, (_match, hex, decimal) =>
      String.fromCodePoint(hex ? Number.parseInt(hex, 16) : Number(decimal))
    )
    .replace(NAMED_REFERENCE, (_match, name) => NAMED.get(name.toLowerCase())!);
  return !(EVENT_HANDLER.test(decoded) || FETCH.test(decoded));
}
