import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';

/* A card that zooms out of its slot into a centred dialog and back
   (human/study-progress.md 2026-10-25, Quick review): the finished card
   scales up from the slot's box while a copy of the slot's face, held at
   the slot's size, fades out over it. Closing runs the same way back. With
   no slot on screen, or reduced motion, it fades instead. */

const OPEN_MS = 350; // --motion-duration-medium
const CLOSE_MS = 250; // --motion-duration-fast
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'; // --motion-ease-smooth-out

export type ZoomCardHandle = { close: () => void };

export function ZoomCard({
  ref,
  source,
  face,
  title,
  aside,
  onClosed,
  returnFocus,
  children,
}: {
  ref?: Ref<ZoomCardHandle>;
  /** The slot the card zooms out of and back into. */
  source: () => HTMLElement | undefined;
  /** The slot's own content, drawn at the slot's size during the zoom. */
  face: ReactNode;
  title: string;
  aside?: ReactNode;
  onClosed: () => void;
  /** Where focus goes once the card is gone, when its slot left with it. */
  returnFocus?: () => HTMLElement | undefined;
  children: ReactNode;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const opening = useRef<Animation[]>([]);
  // The latest callbacks, so the card's ref and close keep one identity.
  const latest = useRef({ onClosed, returnFocus, source });
  useLayoutEffect(() => {
    latest.current = { onClosed, returnFocus, source };
  });

  const close = useCallback(() => {
    const node = card.current;
    if (closing.current || !node || !overlay.current) return;
    closing.current = true;
    // Nothing takes input while it leaves.
    node.inert = true;
    // A close mid-open measures the card at rest, not part-scaled.
    for (const a of opening.current) a.cancel();
    settle(node);
    const slot = latest.current.source();
    slot?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    void Promise.all(
      zoom(node, overlay.current, slot, false).map((a) => a.finished)
    )
      .catch(() => {})
      .then(() => latest.current.onClosed());
  }, []);
  useImperativeHandle(ref, () => ({ close }), [close]);

  // Radix mounts the portal a render late, so the zoom starts when the card
  // node arrives rather than in an effect, once.
  const attach = useCallback((node: HTMLDivElement | null) => {
    card.current = node;
    if (!node || !overlay.current || opening.current.length) return;
    const animations = zoom(
      node,
      overlay.current,
      latest.current.source(),
      true
    );
    opening.current = animations;
    void Promise.all(animations.map((a) => a.finished))
      .then(() => {
        // Open: drop the animations so the card sizes with its content.
        if (closing.current) return;
        settle(node);
        for (const a of animations) a.cancel();
      })
      .catch(() => {});
  }, []);

  return (
    <DialogPrimitive.Root onOpenChange={(open) => !open && close()} open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
          ref={overlay}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[min(576px,calc(100vw-2rem))] origin-top-left overflow-y-auto rounded-card border border-line bg-surface shadow-card outline-none"
          onCloseAutoFocus={(e) => {
            // Radix returns focus to the slot clicked first, which may be gone.
            const target = [
              latest.current.source(),
              latest.current.returnFocus?.(),
            ].find((el) => el?.isConnected);
            if (!target) return;
            e.preventDefault();
            target.focus();
          }}
          ref={attach}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 hidden origin-top-left flex-col justify-between gap-2 p-3"
            data-zoom-face
          >
            {face}
          </div>
          <div
            className="flex flex-col gap-3.5 px-4 pt-3 pb-4 sm:px-5 sm:pb-5"
            data-zoom-body
          >
            <div className="flex items-center gap-2">
              <DialogPrimitive.Title className="t-meta min-w-0 flex-1 truncate text-fg-muted">
                {title}
              </DialogPrimitive.Title>
              {aside}
              <IconButton
                className="-mr-2"
                icon="x"
                label={m.action_close()}
                onClick={close}
                size="xs"
                variant="ghost-hover"
              />
            </div>
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The card at rest: no face copy, scrolling again. */
function settle(card: HTMLElement) {
  const face = card.querySelector<HTMLElement>('[data-zoom-face]');
  if (face) face.style.display = '';
  card.style.overflow = '';
}

/** Zooms the card between the slot's box and its own, or fades it when the
 * slot is off screen or motion is reduced. */
function zoom(
  card: HTMLElement,
  overlay: HTMLElement,
  slot: HTMLElement | undefined,
  opening: boolean
): Animation[] {
  const face = card.querySelector<HTMLElement>('[data-zoom-face]');
  const body = card.querySelector<HTMLElement>('[data-zoom-body]');
  if (!face || !body) return [];
  const timing: KeyframeAnimationOptions = {
    duration: opening ? OPEN_MS : CLOSE_MS,
    easing: EASE,
    fill: 'both',
  };
  const from = slot?.getBoundingClientRect();
  const to = card.getBoundingClientRect();
  const onScreen =
    from &&
    from.width > 0 &&
    from.bottom > 0 &&
    from.top < innerHeight &&
    from.right > 0 &&
    from.left < innerWidth;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // No scrollbars while the card is scaled.
  card.style.overflow = 'hidden';
  const animations = [
    overlay.animate({ opacity: opening ? [0, 1] : [1, 0] }, timing),
  ];

  if (reduce || !onScreen || !slot) {
    // The dialog's own small scale (reduced motion: the fade only).
    const small = { opacity: 0, transform: reduce ? 'none' : 'scale(0.96)' };
    const big = { opacity: 1, transform: 'none' };
    card.style.transformOrigin = 'center';
    animations.push(
      card.animate(opening ? [small, big] : [big, small], timing)
    );
  } else {
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    const r0 = Number.parseFloat(getComputedStyle(slot).borderTopLeftRadius);
    const r1 = Number.parseFloat(getComputedStyle(card).borderTopLeftRadius);
    const small = {
      // Elliptical so the scaled corner reads as the slot's radius.
      borderRadius: `${r0 / sx}px / ${r0 / sy}px`,
      transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`,
    };
    const big = { borderRadius: `${r1}px`, transform: 'none' };
    card.style.transformOrigin = '';
    animations.push(
      card.animate(opening ? [small, big] : [big, small], timing)
    );
    // The face copy keeps the slot's size: counter-scaled against the card.
    Object.assign(face.style, {
      display: 'flex',
      height: `${from.height}px`,
      transform: `scale(${1 / sx}, ${1 / sy})`,
      width: `${from.width}px`,
    });
    animations.push(
      face.animate(
        opening
          ? [{ opacity: 1 }, { offset: 0.3, opacity: 0 }, { opacity: 0 }]
          : [{ opacity: 0 }, { offset: 0.55, opacity: 0 }, { opacity: 1 }],
        timing
      ),
      body.animate(
        opening
          ? [
              { opacity: 0 },
              { offset: 0.15, opacity: 0 },
              { offset: 0.6, opacity: 1 },
              { opacity: 1 },
            ]
          : [{ opacity: 1 }, { offset: 0.45, opacity: 0 }, { opacity: 0 }],
        timing
      )
    );
  }
  return animations;
}
