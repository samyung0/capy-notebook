import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

/** Full screen in the URL (`?fullscreen=true`), so the back gesture leaves it
 * (the workspace's open item, the Grading tab). Leaving after this page
 * pushed the entry it is on pops it, so Back afterwards does not land on the
 * same page again; else (a loaded full screen URL, or the page moved on inside
 * full screen, as Grading's members do) it replaces. Escape leaves it unless something
 * open (a menu, a dialog) already took the key. The route's search parser
 * keeps `fullscreen`. */
export function useFullscreenSearch({
  fieldsKeepEscape = false,
}: {
  /** Escape typed in a field (an input, a text or math editor) stays the
   * field's, as an editor's own full screen needs. */
  fieldsKeepEscape?: boolean;
} = {}) {
  const isFullscreen =
    useSearch({ select: (search) => search.fullscreen, strict: false }) ===
    true;
  const navigate = useNavigate();
  const router = useRouter();
  // The history index full screen's own entry got; null when it did not push.
  const pushedAt = useRef<number | null>(null);
  const setFullscreen = useCallback(
    (on: boolean) => {
      const index = router.history.location.state.__TSR_index;
      if (!on && pushedAt.current === index) {
        pushedAt.current = null;
        router.history.back();
        return;
      }
      pushedAt.current = on ? index + 1 : null;
      void navigate({
        replace: !on,
        search: (previous) => ({
          ...previous,
          fullscreen: on ? (true as const) : undefined,
        }),
        to: '.',
      });
    },
    [navigate, router]
  );
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (
        fieldsKeepEscape &&
        (event.target as Element | null)?.closest?.(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], math-field'
        )
      )
        return;
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fieldsKeepEscape, isFullscreen, setFullscreen]);
  return [isFullscreen, setFullscreen] as const;
}
