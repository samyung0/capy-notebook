import type { CSSProperties, Ref } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

/**
 * The marks a co-editor leaves on a note and on a canvas (Epo 2026-10-28,
 * presence mocks P1 and B3; one look for both, Epo 2026-11-18): a pointer and
 * an outline around what they selected, in their colour, with their name.
 * The page places them; here is only how they look.
 *
 * A note places them in pixels. A canvas places them in board units inside a
 * layer scaled by `--presence-zoom` (`zoomed`), so they follow the board's
 * pan and zoom by that layer's transform alone, and each is scaled back so
 * it keeps its own size on the screen.
 */

/** The co-editor palette's size (`--peer-0` to `--peer-7` in tailwind.css,
 * the cursors design's eight colours, a shade per theme). */
export const PEER_COLORS = 8;

/** The pointer's tip sits 3.2 units into Cursor02Icon's 24-unit box. */
const POINTER_SIZE = 18;
const POINTER_TIP = (3.2 / 24) * POINTER_SIZE;
/** A name pill is at most 128 px wide (`max-w-32`, then truncated) and starts
 * 14 px from the tip, so a pointer this close to its surface's right edge puts
 * it on its left, as a caret's flag flips (cursors design SPEC.md). */
export const FLIP_WITHIN = 14 + 128;
/** The outline stands this far outside what it surrounds. */
const OUTSET = 4;

/** Where a `zoomed` pointer's tip is, for a move written straight to its
 * element. */
export const pointerTransform = (left: number, top: number) =>
  `translate(${left}px, ${top}px)`;

/**
 * A co-editor's pointer: Cursor02Icon in the peer's colour, its tip at
 * (`left`, `top`), with the name in a pill beside it (`flip`: on its left).
 * It glides to each new position in 120 ms at one speed (Epo 2026-11-18):
 * positions leave every 50 ms but reach a far browser in pairs about 100 ms
 * apart, so it has to outlast that gap (on UAT 80 ms still paused between
 * pairs). With reduced motion it jumps.
 */
export function PeerPointer({
  color,
  flip,
  left,
  name,
  ref,
  top,
  zoomed,
}: {
  /** The palette's index. */
  color: number;
  flip: boolean;
  left: number;
  name: string;
  ref?: Ref<HTMLSpanElement>;
  top: number;
  zoomed?: boolean;
}) {
  const arrow = (
    <>
      <Icon
        className="drop-shadow-[0_1px_1px_rgb(0_0_0/0.3)]"
        fill="currentColor"
        name="pointer"
        size={POINTER_SIZE}
      />
      <span
        className={cn(
          'absolute top-3.5 max-w-32 truncate rounded-[6px] bg-(--peer) px-[7px] font-bold text-(--peer-fg) text-[12.5px] leading-[21px]',
          flip ? 'right-3.5' : 'left-3.5'
        )}
      >
        {name}
      </span>
    </>
  );
  return (
    <span
      className="absolute top-0 left-0 text-(--peer) motion-safe:transition-transform motion-safe:duration-[120ms] motion-safe:ease-linear"
      data-remote-pointer={name}
      ref={ref}
      style={
        {
          '--peer': `var(--peer-${color})`,
          transform: zoomed
            ? pointerTransform(left, top)
            : `translate(${left - POINTER_TIP}px, ${top - POINTER_TIP}px)`,
        } as CSSProperties
      }
    >
      {zoomed ? (
        // The glide above runs in board units; the arrow keeps its own size.
        <span
          className="relative block origin-top-left"
          style={{
            transform: `scale(calc(1 / var(--presence-zoom))) translate(${-POINTER_TIP}px, ${-POINTER_TIP}px)`,
          }}
        >
          {arrow}
        </span>
      ) : (
        arrow
      )}
    </span>
  );
}

/**
 * What a co-editor selected: a 2 px outline 4 px outside the box, its corners
 * the theme's (half its button radius), with the name at its top right.
 */
export function PeerOutline({
  color,
  height,
  left,
  name,
  top,
  width,
  zoomed,
}: {
  /** The palette's index. */
  color: number;
  height: number;
  left: number;
  name: string;
  top: number;
  width: number;
  zoomed?: boolean;
}) {
  const box: CSSProperties = zoomed
    ? {
        // Sized in screen pixels and scaled back, so its line, corners and
        // name keep their size at any zoom (a border narrower than one of
        // the layer's pixels would be drawn a whole one wide).
        height: `calc(${height}px * var(--presence-zoom) + ${OUTSET * 2}px)`,
        left,
        top,
        transform: `scale(calc(1 / var(--presence-zoom))) translate(${-OUTSET}px, ${-OUTSET}px)`,
        transformOrigin: '0 0',
        width: `calc(${width}px * var(--presence-zoom) + ${OUTSET * 2}px)`,
      }
    : {
        height: height + OUTSET * 2,
        left: left - OUTSET,
        top: top - OUTSET,
        width: width + OUTSET * 2,
      };
  return (
    <span
      className="absolute rounded-[calc(var(--radius-button)/2)] border-(--peer) border-2"
      data-remote-run={name}
      style={{ '--peer': `var(--peer-${color})`, ...box } as CSSProperties}
    >
      <span className="absolute -top-[11px] right-1.5 max-w-32 truncate rounded-[6px] bg-(--peer) px-[7px] font-bold text-(--peer-fg) text-[12.5px] leading-[21px]">
        {name}
      </span>
    </span>
  );
}
