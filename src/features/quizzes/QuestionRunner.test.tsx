import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { m } from '@/i18n';
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
  // Your order first, then the correct order.
  expect(html.indexOf('Your order')).toBeLessThan(html.indexOf('Second event'));
  expect(html.indexOf('Second event')).toBeLessThan(
    html.indexOf('First event')
  );
  expect(html.indexOf('First event')).toBeLessThan(
    html.indexOf('Correct order')
  );
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

it('marks a checked choice in its box and says Right or Wrong with the marks above', () => {
  const reviewed = (choice: number[]) => {
    const question = exampleQuestion('mcq');
    question.parts[0].awarded = choice[0] === 1 ? 1 : 0;
    return renderToStaticMarkup(
      <QuestionRunner
        answers={{ 'mcq-part': choice }}
        question={question}
        review
      />
    );
  };
  const right = reviewed([1]);
  expect(right).toContain('Right<span class="t-meta');
  expect(right).toContain('>1 / 1 mark</span>');
  const wrong = reviewed([0]);
  expect(wrong).toContain('Wrong<span class="t-meta');
  expect(wrong).toContain('Your answer');
  expect(wrong).toContain('Correct answer');
  const skipped = reviewed([]);
  expect(skipped).toContain('Not answered · 0 / 1 mark');
  expect(skipped).toContain('Correct answer');
});

it('lists a wrong multi-answer part as your answer, then the correct answer apart', () => {
  const question = exampleQuestion('multi', {
    correct: [0, 2],
    options: ['Nucleus', 'Ribosome', 'Mitochondria'],
    type: 'mcq',
  });
  question.parts[0].marks = 2;
  question.parts[0].awarded = 0;
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'multi-part': [0, 1] }}
      question={question}
      review
    />
  );
  expect(html).toContain('0 / 2 marks · 1 right, 1 wrong');
  expect(html.indexOf('Your answer')).toBeLessThan(
    html.indexOf('Correct answer')
  );
  // The chosen wrong option says Wrong; nothing in your answer is outlined.
  expect(html).toContain('Wrong</span>');
  expect(html.slice(html.indexOf('Correct answer'))).toContain('Mitochondria');
  expect(html.slice(html.indexOf('Correct answer'))).not.toContain('Ribosome');
});

// The in-app review shared by a quiz, Practice and a review session.
it('reads a part left Not marked as unmarked, with its marking points, not as 0', () => {
  const question = exampleQuestion('open', {
    accepted: [],
    hints: [],
    type: 'open',
  });
  question.parts[0].marks = 4;
  question.parts[0].markscheme = [{ marks: 4, text: 'Names the factor.' }];
  question.parts[0].awarded = 0;
  question.parts[0].pending = true;
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'open-part': 'CO2 limits it.' }}
      headerMarks
      question={question}
      questionNumber={1}
      review
    />
  );
  expect(html).toContain(m.assignment_not_marked());
  expect(html).toContain('— / 4');
  expect(html).not.toContain('0 / 4');
  expect(html).toContain('Names the factor.');
  expect(html).toContain('[4]');
});
