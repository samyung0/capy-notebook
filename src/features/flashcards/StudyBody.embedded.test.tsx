import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it } from 'vitest';
import { getLocale, m } from '@/i18n';

/* An embedded set's Reset, at the far left of Previous and Next (Epo
   2026-11-13): there once the run has moved on, and back to the first card. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const { createRoot } = await import('react-dom/client');
const { StudyBody } = await import('./StudyBody');

const cards = ['Nucleus', 'Ribosome', 'Golgi'].map((front, i) => ({
  back: `Back ${i}`,
  front,
  id: `c${i}`,
}));

it('starts an embedded set over from the Reset at the left of its steps', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StudyBody
        cards={cards}
        embedded
        name=""
        onRate={() => undefined}
        trail={[]}
      />
    )
  );
  const named = (name: string) =>
    [...host.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === name
    );
  const position = (n: number) =>
    m.flashcards_card_of_total({ position: n, total: 3 });
  expect(named(m.action_reset())).toHaveLength(0);
  await act(async () => named(m.action_next())[0]?.click());
  expect(host.textContent).toContain(position(2));
  await act(async () => named(m.action_reset())[0]?.click());
  expect(host.textContent).toContain(position(1));
  expect(named(m.action_reset())).toHaveLength(0);
  await act(async () => root.unmount());
  host.remove();
});
