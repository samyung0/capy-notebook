import { useRef, useSyncExternalStore } from 'react';
import { m } from '@/i18n';
import { challengeSlot, onChallenge, takeTurnstileToken } from './turnstile';

/** A signed-out check's Turnstile challenge, under its Check (Q372): `view`
 * holds the widget's slot, which turnstile.ts shows while a solve runs and
 * hides once it settles, and a hint while Cloudflare shows the visitor a
 * challenge; `take` gets the check's token there. */
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
      <div data-turnstile-check>
        <p className="t-meta mt-3 mb-2 text-fg-muted" hidden={!showing}>
          {m.quiz_captcha_challenge()}
        </p>
        <div ref={slot} />
      </div>
    ),
  };
}
