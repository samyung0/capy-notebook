import {
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Toast } from '../ui/Toast';
import {
  dismissToast,
  finishToast,
  type QueuedToast,
  toastDuration,
  useShownToasts,
} from '../ui/userToast';

/** The toasts on screen, centred at the bottom: an open error at the
 * bottom, the other toast just above it. It portals to <body>, so it paints
 * over dialogs, drawers and the phone chat button rather than in `#root`'s
 * stacking context. */
export function AppToaster() {
  const { error, other } = useShownToasts();
  if (!error && !other) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-4 bottom-[calc(20px+env(safe-area-inset-bottom))] z-9999 flex flex-col items-center gap-2">
      {other && <ShownToast key={other.id} toast={other} />}
      {error && <ShownToast key={error.id} toast={error} />}
    </div>,
    document.body
  );
}

/** Ding's swipe (Epo 2026-11-09): far enough down or sideways, or a quick
 * flick, throws the toast away; anything less springs it back. */
function flungAway(dx: number, dy: number, ms: number) {
  const speed = Math.hypot(dx, dy) / Math.max(1, ms);
  return (
    dy > 40 ||
    Math.abs(dx) > 80 ||
    (speed > 0.5 && (dy > 15 || Math.abs(dx) > 15))
  );
}

/** Fades in and out with the motion tokens (motion-fade). Its timer restarts
 * whenever the toast fires again and pauses while hovered or the tab is
 * hidden. A drag moves it (up into the screen only a little): see
 * `flungAway`. */
function ShownToast({ toast }: { toast: QueuedToast }) {
  const node = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const remaining = useRef<{ revision: number; ms: number } | null>(null);
  const drag = useRef<{ x: number; y: number; at: number } | null>(null);
  const duration = toastDuration(toast);

  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    if (duration === null || toast.closing) return;
    if (remaining.current?.revision !== toast.revision)
      remaining.current = { ms: duration, revision: toast.revision };
    if (hovered || hidden) return;
    const left = remaining.current;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(toast.id), left.ms);
    return () => {
      clearTimeout(timer);
      left.ms -= Date.now() - started;
    };
  }, [duration, hidden, hovered, toast.closing, toast.id, toast.revision]);

  // Gone once its fade-out ends; reduced motion has none, so it goes at once.
  useLayoutEffect(() => {
    if (!toast.closing) return;
    const animations = node.current?.getAnimations() ?? [];
    let cancelled = false;
    Promise.allSettled(animations.map((animation) => animation.finished)).then(
      () => {
        if (!cancelled) finishToast(toast.id);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [toast.closing, toast.id]);

  // The drag writes the node's style directly: no render per pointer move. It
  // ends on release, on cancel, or when the browser drops the capture (a
  // flick off the window), which would otherwise leave the toast mid-drag.
  const release = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    const el = node.current;
    if (!start || !el) return;
    drag.current = null;
    el.removeAttribute('data-dragging');
    // A captured drag sends no pointerleave until the pointer next moves,
    // and none at all while it is off the window: hovered is read from where
    // the drag ended, so the timer runs again.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    setHovered(!!under && el.contains(under));
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const ms = event.timeStamp - start.at;
    if (!flungAway(dx, dy, ms)) {
      el.style.transition = 'translate 300ms var(--motion-ease-smooth-out)';
      el.style.translate = '0px 0px';
      return;
    }
    // Keeps going the way it was thrown, as far as the release speed says.
    const length = Math.hypot(dx, dy) || 1;
    const reach = Math.max(160, (Math.hypot(dx, dy) / Math.max(1, ms)) * 320);
    el.style.transition =
      'translate 380ms cubic-bezier(.2,.8,.3,1), opacity 250ms ease-out';
    el.style.translate = `${(dx / length) * reach}px ${(dy / length) * reach}px`;
    el.style.opacity = '0';
    dismissToast(toast.id);
  };

  return (
    <div
      className="motion-fade cursor-grab touch-none select-none data-dragging:cursor-grabbing"
      data-state={toast.closing ? 'closed' : 'open'}
      onLostPointerCapture={release}
      onPointerCancel={release}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          toast.closing ||
          (event.target as Element).closest('button')
        )
          return;
        drag.current = {
          at: event.timeStamp,
          x: event.clientX,
          y: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute('data-dragging', '');
        event.currentTarget.style.transition = 'none';
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        // Up, away from the bottom edge, it only gives a little.
        event.currentTarget.style.translate = `${dx}px ${dy < 0 ? dy * 0.2 : dy}px`;
      }}
      onPointerUp={release}
      ref={node}
    >
      <Toast
        count={toast.count}
        onClose={() => dismissToast(toast.id)}
        toast={toast}
      />
    </div>
  );
}
