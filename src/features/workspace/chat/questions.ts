import { isLangAnswer, splitAnswer } from './answer';
import type { ElementNode } from './blocks/Cite';
import { parseAnswer } from './library';
import type { AskUserProps } from './schema';

/** The questions a completed answer asks, in reading order. */
export function extractQuestions(content: string): AskUserProps[] {
  if (!isLangAnswer(content)) return [];
  const result = parseAnswer(splitAnswer(content).program);
  const found: AskUserProps[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as ElementNode;
    if (node.type !== 'element') return;
    if (node.typeName === 'AskUser') {
      const props = node.props as Partial<AskUserProps>;
      if (typeof props.question === 'string' && props.question.trim()) {
        found.push({
          choices: Array.isArray(props.choices)
            ? props.choices.filter((c): c is string => typeof c === 'string')
            : [],
          question: props.question,
        });
      }
      return;
    }
    for (const prop of Object.values(node.props)) visit(prop);
  };
  visit(result?.root);
  return found;
}

export interface QuestionAnswer {
  choice?: string;
  other?: string;
}

/** The user message a set of answers becomes: each answered question with
 * its wording, so the model and the checkpoint summarizer read it without
 * the widget. Skipped questions are left out. */
export function composeAnswers(
  questions: AskUserProps[],
  answers: QuestionAnswer[]
): string {
  return questions
    .map((question, index) => {
      const answer = answers[index];
      const lines = [answer?.choice, answer?.other?.trim()].filter(
        (line): line is string => !!line
      );
      return lines.length ? [question.question, ...lines].join('\n') : '';
    })
    .filter(Boolean)
    .join('\n\n');
}
