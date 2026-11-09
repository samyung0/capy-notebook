import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** Fades in and out with the motion tokens (motion-fade). Its timer restarts
 * whenever the toast fires again and pauses while hovered or the tab is
 * hidden. */
function ShownToast({ toast }: { toast: QueuedToast }) {
  const node = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const remaining = useRef<{ revision: number; ms: number } | null>(null);
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

  return (
    <div
      className="motion-fade"
      data-state={toast.closing ? 'closed' : 'open'}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
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
