import { parseHTML } from 'linkedom';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { m } from '@/i18n';
import { applyItemAwards } from './grade';
import { QuestionRunner } from './QuestionRunner';

it('reviews the graded snapshot with marks, the answer before an open Explanation, and a fixed unit', () => {
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
  // Open under its heading (Epo 2026-11-18), no fold.
  expect(html).not.toContain('<details');
  expect(html).toContain(m.question_ui_worked_solution());
});

// Epo 2026-11-22: a split question's explanation and other key sections sit
// under both columns, the answer and its verdict staying on the right.
it("puts a split question's explanation under both columns", () => {
  const question = exampleQuestion('split', {
    accepted: ['osmosis'],
    type: 'short',
  });
  question.layout = 'split';
  question.stem = [
    { text: 'The chart shows a membrane sample.', type: 'text' },
  ];
  question.parts[0].solution = [
    { text: 'Water moves by osmosis.', type: 'text' },
  ];
  question.parts[0].awarded = 0;
  const { document } = parseHTML(
    `<!doctype html><html><body>${renderToStaticMarkup(
      <QuestionRunner
        answers={{ 'split-part': 'diffusion' }}
        question={question}
        review
      />
    )}</body></html>`
  );
  const columns = document.querySelector('[class*="grid-cols-2"]');
  // The answer field, on the right.
  expect(columns?.innerHTML).toContain('value="diffusion"');
  expect(columns?.textContent).not.toContain('Water moves by osmosis.');
  expect(document.body.textContent).toContain('Water moves by osmosis.');
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

// Epo 2026-11-23: a Canvas part is answered on its canvas, in place; any
// other part's canvas is only looked at.
it('answers a canvas part on its canvas, Answer in Canvas under it before and after Done, its verdict once checked', () => {
  const question = exampleQuestion('draw', { type: 'canvas' });
  question.parts[0].blocks.push({ type: 'canvas' });
  const drawing = { board: 'AAA=', image: 'data:image/webp;base64,AAA=' };
  const taking = (value?: typeof drawing) =>
    renderToStaticMarkup(
      <QuestionRunner
        answers={value ? { 'draw-part': value } : {}}
        question={question}
      />
    );
  expect(taking()).toContain('canvas-dots');
  const answer = `${m.question_canvas_answer()}</button>`;
  expect(taking()).toContain(answer);
  expect(taking()).toContain(m.question_canvas_hint_student());
  // Drawn from its board (here not a real one, so it says it can't be shown).
  expect(taking(drawing)).toContain(
    m.drawing_answer_unreadable().replace("'", '&#x27;')
  );
  expect(taking(drawing)).toContain(answer);
  expect(taking(drawing)).not.toContain(m.question_canvas_hint_student());
  question.parts[0] = applyItemAwards(question.parts[0], [1]);
  const checked = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'draw-part': drawing }}
      question={question}
      review
    />
  );
  expect(checked).toContain('Correct:');
  expect(checked).toContain(m.question_canvas_open());
  expect(checked).not.toContain(answer);

  const choice = exampleQuestion('choice');
  choice.parts[0].blocks.push({ type: 'canvas' });
  const shown = renderToStaticMarkup(
    <QuestionRunner answers={{}} question={choice} />
  );
  // An empty canvas a part only shows is nothing.
  expect(shown).not.toContain('canvas-dots');
  expect(shown).not.toContain(answer);
});

// Epo 2026-11-23, S1: a stem canvas two parts answer in shows once, its hint
// naming them and Answer in Canvas under it; each part says it is answered in
// the canvas above, and a check gives each its verdict on the one drawing.
it('answers a shared stem canvas once for the parts in it, each with its verdict once checked', () => {
  const question = exampleQuestion('shared', { shared: true, type: 'canvas' });
  question.stem = [{ text: 'A cross.', type: 'text' }, { type: 'canvas' }];
  question.parts.push({
    ...question.parts[0],
    blocks: [{ text: 'Write the ratio.', type: 'text' }],
    id: 'shared-b',
  });
  const drawing = { board: 'AAA=', image: 'data:image/webp;base64,AAA=' };
  const taking = renderToStaticMarkup(
    <QuestionRunner answers={{}} question={question} />
  );
  expect(taking).toContain(
    m.question_canvas_hint_shared({ parts: '(a) and (b)' })
  );
  expect(taking.split(`${m.question_canvas_answer()}</button>`)).toHaveLength(
    2
  );
  expect(taking.split(m.question_canvas_in_canvas_above())).toHaveLength(3);
  question.parts = question.parts.map((part) => applyItemAwards(part, [1]));
  const checked = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'shared-part': drawing }}
      question={question}
      review
    />
  );
  expect(checked.split('Correct:')).toHaveLength(3);
  expect(checked).not.toContain(m.question_canvas_in_canvas_above());
});

// Epo 2026-11-18, L1: a checked choice marks only the learner's own pick,
// gives its verdict under the boxes and lists the correct answer apart.
it('marks only the picked box and says Correct or Wrong with the marks under it', () => {
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
  expect(right).toContain('>Correct</span>');
  expect(right).not.toContain('Correct answer');
  const wrong = reviewed([0]);
  expect(wrong).toContain('Wrong</span>');
  expect(wrong.indexOf('>Wrong</span>')).toBeLessThan(
    wrong.indexOf('Correct answer')
  );
  const skipped = reviewed([]);
  expect(skipped).toContain(`>${m.assignment_not_answered()}</span>`);
  expect(skipped).toContain('Correct answer');
});

// Epo 2026-11-18, A: a member's result lists the options as lines, then
// what they picked and what was correct.
it('lists a member result as options, your answer, then the correct answer', () => {
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
      layout="list"
      partResults={false}
      question={question}
      review
    />
  );
  expect(html).not.toContain('<button');
  const yours = html.slice(
    html.indexOf('Your answer'),
    html.indexOf('Correct answer')
  );
  expect(yours).toContain('Ribosome');
  expect(yours).toContain('Wrong</span>');
  expect(html.slice(html.indexOf('Correct answer'))).toContain('Mitochondria');
  expect(html.slice(html.indexOf('Correct answer'))).not.toContain('Ribosome');
});

// Epo 2026-11-18: blanks list their correct answers as a short answer does,
// all right or not.
it("lists the blanks' correct answers on review even when all are right", () => {
  const question = exampleQuestion('gaps', {
    accepted: [['osmosis'], ['dilute']],
    type: 'gaps',
  });
  question.parts[0].blocks = [
    { text: 'Water moves by (1) ___ from a (2) ___ solution.', type: 'text' },
  ];
  question.parts[0].marks = 2;
  question.parts[0].awarded = 2;
  question.parts[0].itemResults = [true, true];
  const html = renderToStaticMarkup(
    <QuestionRunner
      answers={{ 'gaps-part': ['osmosis', 'dilute'] }}
      question={question}
      review
    />
  );
  expect(html).toContain(m.question_ui_correct_answers());
});

// The in-app review shared by a quiz, Practice and a review session.
it('reads a part left Not marked as unmarked, with its marking points, not as 0', () => {
  const question = exampleQuestion('open', {
    accepted: [],
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
