import { useEffect, useState } from 'react';
import { m } from '@/i18n';

/** How long a slowed open shows only its loading state (Epo 2026-10-20). */
const SLOWED_LINE_MS = 5000;

/**
 * Whether a slowed open has lasted long enough to say why: the room's answer
 * waits on the user's open budget, spent by many large opens lately (Epo
 * 2026-10-20). The loading state stays; its line shows after 5 s.
 */
export function useSlowedLine(slowed: boolean) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (!slowed) return;
    const timer = setTimeout(() => setShown(true), SLOWED_LINE_MS);
    return () => clearTimeout(timer);
  }, [slowed]);
  return slowed && shown;
}

/** Under a loading state: why a slowed open still loads, after 5 s. */
export function SlowedOpenLine({ slowed }: { slowed: boolean }) {
  if (!useSlowedLine(slowed)) return null;
  return (
    <p className="t-meta text-fg-muted" role="status">
      {m.editor_open_slowed()}
    </p>
  );
}
