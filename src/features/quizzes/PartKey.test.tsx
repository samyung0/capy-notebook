import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { QuestionPart } from '@/features/questions/types';
import { getLocale, m } from '@/i18n';
import { PartKey } from './QuestionPane';

/* While its keys come, a closed card draws what the content holds, unmarked,
   so their coming shifts little. */

getLocale();
const part = (answer: QuestionPart['answer'], text = ''): QuestionPart => ({
  answer,
  blocks: [{ text, type: 'text' }],
  id: 'p1',
  marks: 1,
  solution: [],
});
const draw = (value: QuestionPart, pending = true) =>
  renderToStaticMarkup(<PartKey part={value} pending={pending} />);

it('draws choice and True / False rows unmarked while keys come', () => {
  const choice = draw(part({ correct: [], options: ['Nucleus'], type: 'mcq' }));
  expect(choice).toContain('Nucleus');
  expect(choice).not.toContain(m.question_ui_status_correct());
  const truth = draw(part({ correct: false, type: 'boolean' }));
  expect(truth).toContain(m.question_ui_true());
  expect(truth).not.toContain(m.question_ui_status_correct());
});

it("draws a gaps part's blanks from its text while keys come", () => {
  const html = draw(
    part({ accepted: [], type: 'gaps' }, '(1) ______ and (2) ______')
  );
  // A chip per blank, not the empty-gaps hint.
  expect(html.match(/bg-tint-accent-1 /g)).toHaveLength(2);
  expect(html).not.toContain(m.question_ui_gaps_hint());
});

it('waits on a part whose key holds its items', () => {
  expect(draw(part({ items: [], type: 'ordering' }))).toBe('');
});
