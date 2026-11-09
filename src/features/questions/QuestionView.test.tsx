import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AnswerView, QuestionReview, QuestionView } from './QuestionView';
import { exampleQuestion } from './questionFixtures';
import type { Question } from './types';

it('typesets bare LaTeX answers and joins a plain degree unit to each value', () => {
  const answer = (accepted: string[], unit?: string) =>
    renderToStaticMarkup(
      <AnswerView
        part={exampleQuestion('q', { accepted, type: 'short', unit }).parts[0]}
      />
    );
  const latex = answer(['-2\\sqrt{5}', '-2√5']);
  expect(latex.match(/role="math"/g)).toHaveLength(1);
  expect(latex).not.toContain('sqrt');
  expect(latex).toContain('<span> -2√5</span>');
  expect(answer(['65'], '°')).toContain('65°');
  expect(answer(['65'], '°C')).toContain('65 °C');
  expect(answer(['53.1', '53.13'], '°')).toContain('53.1°; 53.13°');
});

it("shows a lone part's marks once, in the header", () => {
  const question = exampleQuestion('q');
  question.stem = [{ text: 'A cell is observed.', type: 'text' }];
  question.parts[0].marks = 3;
  const html = renderToStaticMarkup(<QuestionView question={question} />);
  expect(html).toContain('3 marks');
  expect(html).not.toContain('[3]');
});

/** A stem, (a), (b) holding a text over (i) and (ii), then (c): board U2. */
function grouped(labels: Question['labels'] = 'letters'): Question {
  const part = (id: string, text: string, marks: number, group?: string) => ({
    ...exampleQuestion(id).parts[0],
    blocks: [{ text, type: 'text' as const }],
    id,
    marks,
    ...(group ? { group } : {}),
  });
  return {
    ...exampleQuestion('q'),
    groups: [
      {
        blocks: [{ text: 'Fig. 3.2 shows clotting.', type: 'text' }],
        id: 'b',
      },
    ],
    labels,
    parts: [
      part('a', 'State the function.', 1),
      part('b1', 'Fill in the boxes.', 2, 'b'),
      part('b2', 'State two roles.', 2, 'b'),
      part('c', 'Explain.', 3),
    ],
  };
}

const UNSEEN_LABEL = /<span aria-hidden="true"[^>]*>[^<]*<\/span>/g;
const TAG = /<[^>]+>/g;
const SPACE = /\s+/g;
const LABEL_SPAN = /<span class="([^"]*)">([^<]*)<\/span>/g;

/** The question as read: tags gone, and the unseen labels that size the label
 * column with them. */
const shownText = (question: Question) =>
  renderToStaticMarkup(<QuestionView question={question} />)
    .replace(UNSEEN_LABEL, '')
    .replace(TAG, ' ')
    .replace(SPACE, ' ');

it('labels a group as a part and its parts (i), (ii), the marks on each part', () => {
  const shown = shownText(grouped());
  expect(shown).toContain('(a) State the function. 1 mark');
  expect(shown).toContain('(b) Fig. 3.2 shows clotting. (i)');
  expect(shown).toContain('(i) Fill in the boxes. 2 marks');
  expect(shown).toContain('(ii) State two roles. 2 marks');
  expect(shown).toContain('(c) Explain. 3 marks');
  // The header's total is the parts'.
  expect(shown).toContain('8 marks');
});

it("takes the question's labels at the top level and keeps (i) inside a group", () => {
  const shown = shownText(grouped('numbers'));
  expect(shown).toContain('1. State the function.');
  expect(shown).toContain('2. Fig. 3.2 shows clotting.');
  expect(shown).toContain('(i) Fill in the boxes.');
  expect(shown).toContain('3. Explain.');
});

it('steps a sub-part in on larger screens only', () => {
  const html = renderToStaticMarkup(<QuestionView question={grouped()} />);
  const step = '@min-[36rem]/question:pl-4';
  const shownClass = (text: string) =>
    [...html.matchAll(LABEL_SPAN)].find(
      (match) => match[2] === `(${text})` && !match[1].includes('invisible')
    )?.[1] ?? '';
  expect(shownClass('i').split(' ')).toContain(step);
  expect(shownClass('ii').split(' ')).toContain(step);
  expect(shownClass('b').split(' ')).not.toContain(step);
  // No step on a phone: the larger-screen class is its only padding.
  expect(shownClass('i').split(' ')).not.toContain('pl-4');
});

it('labels a lone part inside a group, since the group is printed beside it', () => {
  const question = grouped();
  question.parts = [question.parts[1]];
  const shown = shownText(question);
  expect(shown).toContain('(a) Fig. 3.2 shows clotting.');
  expect(shown).toContain('(i) Fill in the boxes.');
});

it("totals a checked question's parts in its header, a group adding none", () => {
  const question = grouped();
  question.parts = question.parts.map((part, i) => ({
    ...part,
    awarded: [1, 0, 2, 3][i],
  }));
  const html = renderToStaticMarkup(<QuestionReview question={question} />);
  expect(html.replace(TAG, ' ').replace(SPACE, ' ')).toContain('6 / 8 marks');
});
