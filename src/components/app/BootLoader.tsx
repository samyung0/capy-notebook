import type { AnyRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

const CYCLE_MS = 2500;

/**
 * index.html's boot loader, drawn again wherever the app still waits before
 * its first page (Clerk, the first page's code), so a first load shows one
 * loader throughout (Q905). Its styles live in index.html. The dots pick up
 * the phase the index.html dots reached, which started with the document,
 * instead of restarting their leap.
 */
export function BootLoader() {
  const phase = performance.now() % CYCLE_MS;
  // The second and third dots trail as index.html's nth-child delays do.
  const delays = [0, CYCLE_MS / 1.5, CYCLE_MS / 3];
  return (
    <div aria-label="Loading" className="boot-loader" role="status">
      <span>
        {delays.map((delay) => (
          <i key={delay} style={{ animationDelay: `-${phase + delay}ms` }} />
        ))}
      </span>
    </div>
  );
}

/** The loader beside the router until its first page draws: the router
 * renders nothing before its first load starts, and the page's code may still
 * be on its way. Every load resolves, an error page's too. */
export function FirstLoadLoader({ router }: { router: AnyRouter }) {
  const [loading, setLoading] = useState(() => !router.state.resolvedLocation);
  useEffect(() => {
    if (!loading) return;
    const unsubscribe = router.subscribe('onResolved', () => setLoading(false));
    // Resolved before this subscribed.
    if (router.state.resolvedLocation) setLoading(false);
    return unsubscribe;
  }, [loading, router]);
  return loading ? <BootLoader /> : null;
}
