import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { m } from '@/i18n';
import type { PinnedQuestion } from './drawing/DrawingBoardScreen';
import { QuestionRunner } from './QuestionRunner';

// The card a part's board pins, drawn where its canvas would be.
vi.mock('./drawing/CanvasAnswer', () => ({
  CanvasAnswer: ({ pinned }: { pinned: PinnedQuestion }) => (
    <section>
      <b>{pinned.title}</b>
      {pinned.body}
    </section>
  ),
}));

// The pinned card's markup, its apostrophes unescaped.
const cardText = (html: string) =>
  html.slice(html.indexOf('<section>')).replaceAll('&#x27;', "'");

const ownCanvasQuestion = () => {
  const question = exampleQuestion('own', { type: 'canvas' });
  question.stem = [
    { text: 'The graph shows plant P.', type: 'text' },
    { board: 'board-1', image: 'image-1', type: 'canvas' },
  ];
  question.parts[0].blocks = [
    { text: 'Sketch plant Q.', type: 'text' },
    { type: 'canvas' },
  ];
  return question;
};

// S3 (Epo 2026-11-23): a part's own board pins the question's text and the
// part's, then the canvas above it as a small picture.
it("pins a part's text before the question's canvas above it", () => {
  const html = renderToStaticMarkup(
    <QuestionRunner answers={{}} question={ownCanvasQuestion()} />
  );
  const card = cardText(html);
  expect(card.indexOf('The graph shows plant P.')).toBeLessThan(
    card.indexOf('Sketch plant Q.')
  );
  expect(card.indexOf('Sketch plant Q.')).toBeLessThan(
    card.indexOf(m.question_canvas_above())
  );
});

// An assignment shows the question's first line as its heading and runs the
// rest; the board still pins the question whole, with its number.
it('pins the whole question when its first line went to the heading', () => {
  const question = ownCanvasQuestion();
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{}}
      pinFrom={{ number: 4, question }}
      question={{ ...question, stem: question.stem.slice(1) }}
    />
  );
  const card = cardText(html);
  expect(card).toContain(m.quiz_editor_question({ number: 4 }));
  expect(card).toContain('The graph shows plant P.');
});
