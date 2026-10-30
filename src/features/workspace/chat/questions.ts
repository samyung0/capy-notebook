import type { AskUserProps } from './blocks/AskUser';
import { fenceJson, parseMarkdownAnswer } from './markdownSegments';

/** The questions of an `ask` fence, one JSON object per line. */
export function askQuestions(body: string): AskUserProps[] {
  return body.split('\n').flatMap((line) => {
    const { choices, question } = fenceJson(line) ?? {};
    if (typeof question !== 'string' || !question.trim()) return [];
    return {
      choices: Array.isArray(choices)
        ? choices.filter((c): c is string => typeof c === 'string')
        : [],
      question,
    };
  });
}

/** The questions a completed answer asks, in reading order. */
export function extractQuestions(content: string): AskUserProps[] {
  return parseMarkdownAnswer(content).flatMap((segment) =>
    segment.type === 'figure' && segment.lang === 'ask' && segment.closed
      ? askQuestions(segment.body)
      : []
  );
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
