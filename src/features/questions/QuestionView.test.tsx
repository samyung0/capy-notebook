import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AnswerView, QuestionView } from './QuestionView';
import { exampleQuestion } from './questionFixtures';

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
