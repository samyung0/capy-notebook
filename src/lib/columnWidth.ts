/** Column widths estimated from character counts at text-sm, so tables can use
 *  a fixed layout without measuring cells. Shared by the CSV preview and
 *  document tables. */
const COLUMN_MIN_PX = 90;
const COLUMN_MAX_PX = 320;
const COLUMN_PADDING_PX = 30;
const CHAR_PX = 7.5;
// CJK and fullwidth characters render about twice as wide as Latin ones.
const WIDE_CHAR_PATTERN = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR_PATTERN.test(char) ? 2 : 1;
  return width;
}

/** The width that fits the longest text, clamped so short columns stay
 *  usable and long ones wrap. */
export function estimateColumnWidth(texts: Iterable<string>): number {
  let chars = 0;
  for (const text of texts) chars = Math.max(chars, displayWidth(text));
  return Math.min(
    COLUMN_MAX_PX,
    Math.max(COLUMN_MIN_PX, Math.round(chars * CHAR_PX + COLUMN_PADDING_PX))
  );
}
