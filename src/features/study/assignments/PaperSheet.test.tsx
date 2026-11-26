import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it } from 'vitest';
import type { LearnerQuestion } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const { createRoot } = await import('react-dom/client');
const { PaperSheet } = await import('./PaperSheet');

const question = (
  id: string,
  text: string,
  answer: LearnerQuestion['parts'][number]['answer']
) =>
  ({
    id,
    labels: 'letters',
    layout: 'paper',
    parts: [
      { answer, blocks: [{ text, type: 'text' }], id: `${id}p`, marks: 2 },
    ],
    stem: [],
  }) as unknown as LearnerQuestion;

// An upload's questions read as a printed paper (Epo 2026-11-25, mock A):
// choices as lettered text, a written question its text alone.
it('lists every question with lettered choices and nothing to fill in', async () => {
  const host = document.getElementById('root') as never;
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PaperSheet
        questions={[
          question('q1', 'Which is dominant?', {
            options: ['B', 'b'],
            type: 'mcq',
          } as never),
          question('q2', 'Explain the wave.', { type: 'open' } as never),
        ]}
      />
    )
  );
  const items = document.querySelectorAll('[data-paper-question]');
  expect(items).toHaveLength(2);
  expect(document.body.textContent).toContain(
    m.quiz_editor_questions({ count: 2 })
  );
  expect(items[0]?.textContent).toContain('Which is dominant?');
  expect(items[0]?.textContent).toContain('AB');
  expect(items[0]?.textContent).toContain('Bb');
  expect(items[1]?.textContent).toContain('Explain the wave.');
  expect(
    document.querySelectorAll('input, textarea, [role="radio"]')
  ).toHaveLength(0);
  act(() => root.unmount());
});
