import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { applyItemAwards } from './grade';
import { QuestionRunner } from './QuestionRunner';
import { gradeAttemptQuestions } from './scoreAttempt';

it('reviews the graded snapshot with marks, the answer before a collapsed scheme, and a fixed unit', async () => {
  const question = exampleQuestion('quantity', {
    accepted: ['2'],
    type: 'short',
    unit: 'cm',
  });
  question.parts[0].markscheme = [
    'Divides the length by two.',
    'Obtains 2 cm.',
  ];
  const answers = { 'quantity-part': '2' };
  const graded = await gradeAttemptQuestions([question], answers, async () => {
    throw new Error('closed parts never call the grader');
  });
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={answers}
      question={graded.questions[0]}
      questionNumber={1}
      review
    />
  );
  expect(html).toContain('2 / 2');
  expect(html.indexOf('value="2"')).toBeLessThan(
    html.indexOf('Divides the length by two.')
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain('>cm</span>');
  // Collapsed: no `open` attribute after the class.
  expect(html).toContain('<details class="col-start-2 min-w-0 text-sm">');
});

it('letters matching options with a dot and reviews the chosen letter', () => {
  const question = exampleQuestion('match', {
    options: ['Stores DNA', 'Makes ATP', 'Unused choice'],
    pairs: [{ left: 'Mitochondria', right: 1 }],
    type: 'matching',
  });
  const render = (review: boolean) =>
    renderToStaticMarkup(
      <QuestionRunner
        answers={{ 'match-part': { '0': 2 } }}
        question={question}
        review={review}
      />
    );
  const taking = render(false);
  expect(taking).toContain('aria-label="Mitochondria"');
  for (const letter of ['A.', 'B.', 'C.']) expect(taking).toContain(letter);
  const reviewed = render(true);
  expect(reviewed).toContain('>C<');
  expect(reviewed).toContain('Correct: B');
});

it('shows an open part with one mark per marking item and an unanswered ordering response', () => {
  const question = exampleQuestion('open', {
    accepted: ['Supporting evidence'],
    hints: [],
    type: 'open',
  });
  question.parts[0].markscheme = ['States the claim.', 'Gives evidence.'];
  question.parts[0] = applyItemAwards(question.parts[0], [1, 0.5]);
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'open-part': 'Some evidence' }}
      question={question}
      review
    />
  );
  expect(html).toContain('1.5 / 2');
  expect(html).toContain('text-tint-warning-fg');
  const ordering = exampleQuestion('ordering', {
    items: ['First event', 'Second event'],
    type: 'ordering',
  });
  const unanswered = renderToStaticMarkup(
    <QuestionRunner answers={{}} question={ordering} review />
  );
  expect(unanswered).toContain('0 / 1');
  expect(unanswered).toContain('<p>—</p>');
  expect(unanswered).not.toContain('First event');
});
