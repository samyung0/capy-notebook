import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { applyOpenAward } from './grade';
import { QuestionRunner } from './QuestionRunner';
import { gradeAttemptQuestions } from './scoreAttempt';

it('reviews the graded snapshot with marks, scheme, fixed-unit answer and collapsed solution', async () => {
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
  const graded = await gradeAttemptQuestions([question], answers, {});
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={answers}
      onChange={() => {}}
      question={graded.questions[0]}
      questionNumber={1}
      review
    />
  );
  expect(html).toContain('2 / 2');
  expect(html.match(/text-solid-success/g)).toHaveLength(2);
  expect(html.indexOf('Marking scheme')).toBeLessThan(
    html.indexOf('Your answer')
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain('value="2"');
  expect(html).toContain('>cm</span>');
  // Collapsed: no `open` attribute after the class.
  expect(html).toContain('<details class="col-start-2 min-w-0">');
});

it('letters matching options in stored order and keeps option indices as answers', () => {
  const question = exampleQuestion('match', {
    options: ['Stores DNA', 'Makes ATP', 'Unused choice'],
    pairs: [{ left: 'Mitochondria', right: 1 }],
    type: 'matching',
  });
  const render = (review: boolean) =>
    renderToStaticMarkup(
      <QuestionRunner
        answers={{ 'match-part': { '0': 2 } }}
        onChange={() => {}}
        question={question}
        review={review}
      />
    );
  expect(render(false)).toContain(
    '<option value="0">A</option><option value="1">B</option><option value="2" selected="">C</option>'
  );
  const reviewed = render(true);
  expect(reviewed).toContain('>C</span>');
  expect(reviewed).toContain('Correct: B');
});

it('shows an open part award without inventing per-item marks or an unanswered ordering response', () => {
  const question = exampleQuestion('open', {
    accepted: ['Supporting evidence'],
    hints: [],
    type: 'open',
  });
  question.parts[0] = applyOpenAward(question.parts[0], 0.5, 'Partly correct.');
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'open-part': 'Some evidence' }}
      onChange={() => {}}
      question={question}
      review
    />
  );
  expect(html).toContain('0.5 / 1');
  expect(html).not.toContain('1 / 1');
  expect(html).toContain('Partly correct.');
  const ordering = exampleQuestion('ordering', {
    items: ['First event', 'Second event'],
    type: 'ordering',
  });
  const unanswered = renderToStaticMarkup(
    <QuestionRunner
      answers={{}}
      onChange={() => {}}
      question={ordering}
      review
    />
  );
  expect(unanswered).toContain('0 / 1');
  expect(unanswered).toContain('<p>—</p>');
  expect(unanswered).not.toContain('First event');
});
