import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AnswerView } from './QuestionView';
import { exampleQuestion } from './questionFixtures';

it('typesets bare LaTeX answers and joins a plain degree unit to its value', () => {
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
});
