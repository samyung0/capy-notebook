import { useRef, useSyncExternalStore } from 'react';
import { m } from '@/i18n';
import { challengeSlot, onChallenge, takeTurnstileToken } from './turnstile';

/** A signed-out check's Turnstile challenge, under its Submit (Q372):
 * `view` takes room only while Cloudflare shows the visitor a challenge,
 * with a hint to complete it, and `take` gets the check's token there. */
export function useTurnstileCheck() {
  const slot = useRef<HTMLDivElement>(null);
  const showing = useSyncExternalStore(
    onChallenge,
    () => slot.current !== null && challengeSlot() === slot.current,
    () => false
  );
  return {
    take: () => {
      if (!slot.current) throw new Error('the check has no Turnstile slot');
      return takeTurnstileToken(slot.current);
    },
    view: (
      <div data-turnstile-check hidden={!showing}>
        <p className="t-meta mt-3 text-fg-muted">
          {m.quiz_captcha_challenge()}
        </p>
        <div className="mt-2" ref={slot} />
      </div>
    ),
  };
}
