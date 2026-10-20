import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { FlashcardResult } from './FlashcardResult';

const AGAIN_THEN_GOOD = /Again<\/span>.*Good/;

const card = (id: string, ...ratings: number[]) => ({
  back: `${id} back`,
  front: `${id} front`,
  id,
  ratings,
});

it('scores first ratings of Good or Easy, shows its gain since the previous attempt and lists every card with both faces', () => {
  const html = renderToStaticMarkup(
    <FlashcardResult
      cards={[card('a', 1, 3), card('b', 4), card('c', 2), card('d', 3)]}
      minutes="9 min"
      previous={{ correct: 1, takenAt: '2026-10-11T09:00:00Z', total: 4 }}
    />
  );
  expect(html).toContain('2 / 4');
  expect(html).toContain(m.flashcards_result_good());
  expect(html).toContain('9 min');
  expect(html).toContain('1 since');
  expect(html).toContain('a front');
  expect(html).toContain('a back');
  // A card rated Again and then Good shows both.
  expect(html).toMatch(AGAIN_THEN_GOOD);
});
