import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/* User-facing copy says what the user sees and can do, leaving out internal
   workings: slots, limiters, verification vendors (Epo 2026-10-24, Q300,
   Q350). */

const INTERNALS = {
  en: /\bslots?\b|limiter|siteverify|turnstile|cloudflare/i,
  zh: /名额|限流|siteverify|turnstile|cloudflare/i,
};

it('names no internal working in any message', () => {
  for (const [locale, internals] of Object.entries(INTERNALS)) {
    const messages: Record<string, unknown> = JSON.parse(
      readFileSync(
        new URL(`../../messages/${locale}.json`, import.meta.url),
        'utf8'
      )
    );
    const named = Object.entries(messages).filter(
      ([, text]) => typeof text === 'string' && internals.test(text)
    );
    expect(named, locale).toEqual([]);
  }
});
