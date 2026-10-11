/* Apart from MediaPreview, so a page sizes its previews without loading the
   preview itself until one opens. */

/** Media with a known size opens at most this many times it: small diagrams
 * stay readable without filling the screen. */
const MAX_UPSCALE = 2;

/**
 * CSS height that opens `width`×`height` media as large as the preview fits,
 * up to MAX_UPSCALE× its size. Set only the height (width auto) so the width
 * follows the aspect ratio. `inset` is the media's own horizontal and
 * vertical padding.
 */
export function previewHeight(width: number, height: number, inset = '0px') {
  return `min(100cqh - ${inset}, ${height * MAX_UPSCALE}px, (100cqw - ${inset}) * ${height / width})`;
}
