import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { applyItemAwards } from './grade';
import { QuestionRunner } from './QuestionRunner';

it('reviews the graded snapshot with marks, the answer before a collapsed solution, and a fixed unit', () => {
  const question = exampleQuestion('quantity', {
    accepted: ['2'],
    type: 'short',
    unit: 'cm',
  });
  question.parts[0].marks = 2;
  question.parts[0].solution = [
    { text: 'Divides the length by two.', type: 'text' },
    { text: 'Obtains 2 cm.', type: 'text' },
  ];
  // The server's award, which the review shows as is.
  question.parts[0].awarded = 2;
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'quantity-part': '2' }}
      question={question}
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

it('answers matching by option text and reviews it against the stored letters', () => {
  const question = exampleQuestion('match', {
    options: ['Stores DNA', 'Makes ATP', 'Unused choice'],
    pairs: [{ left: 'Mitochondria', right: 1 }],
    type: 'matching',
  });
  question.parts[0].awarded = 0;
  // The learner read the options shuffled, so the answer is the text.
  const answers = { 'match-part': { '0': 'Unused choice' } };
  const taking = renderToStaticMarkup(
    <QuestionRunner
      answers={answers}
      question={{
        ...question,
        parts: [
          {
            answer: {
              left: ['Mitochondria'],
              options: ['Unused choice', 'Stores DNA', 'Makes ATP'],
              type: 'matching',
            },
            blocks: question.parts[0].blocks,
            id: 'match-part',
            marks: 1,
          },
        ],
      }}
    />
  );
  expect(taking).toContain('aria-label="Mitochondria"');
  // Phones pick from the letters themselves, the chosen one pressed.
  expect(taking).toContain('aria-pressed="true"');
  for (const letter of ['>A<', '>B<', '>C<']) expect(taking).toContain(letter);
  const reviewed = renderToStaticMarkup(
    <QuestionRunner answers={answers} question={question} review />
  );
  expect(reviewed).toContain('>C<');
  expect(reviewed).toContain('Correct: B');
});

it('reviews an ordering answered by item text against the stored order', () => {
  const question = exampleQuestion('order', {
    items: ['First event', 'Second event', 'Third event'],
    type: 'ordering',
  });
  question.parts[0].awarded = 0;
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{
        'order-part': ['Second event', 'First event', 'Third event'],
      }}
      question={question}
      review
    />
  );
  // The learner's order first, then the correct order with where each
  // misplaced item was put.
  expect(html.indexOf('Second event')).toBeLessThan(
    html.indexOf('First event')
  );
  expect(html).toContain('Correct order');
  expect(html).toContain('you put it at 2');
  expect(html).toContain('you put it at 1');
  expect(html).not.toContain('you put it at 3');
});

it('shows an open part with its marks and a verdict over its marking points', () => {
  const graded = (awards: number[], answer: string) => {
    const question = exampleQuestion('open', {
      accepted: ['Supporting evidence'],
      hints: [],
      type: 'open',
    });
    question.parts[0].marks = 2;
    question.parts[0].markscheme = [
      { marks: 1, text: 'States the claim.' },
      { marks: 1, text: 'Gives evidence.' },
    ];
    question.parts[0] = applyItemAwards(question.parts[0], awards);
    return renderToStaticMarkup(
      <QuestionRunner
        answers={{ 'open-part': answer }}
        question={question}
        review
      />
    );
  };
  const partial = graded([1, 0.5], 'Some evidence');
  expect(partial).toContain('1.5 / 2');
  expect(partial).toContain('Partially correct:');
  expect(partial).toContain('1 of 2 points answered correctly');
  expect(graded([1, 1], 'Both')).toContain('All 2 points answered correctly');
  expect(graded([0, 0], ' ')).toContain('Question not answered');
});
