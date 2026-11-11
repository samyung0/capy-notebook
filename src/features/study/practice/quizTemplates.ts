import type { QuizPreviewQuestion } from '@/api/types';
import { answerLabels } from '@/features/questions/editorFields';
import {
  modelMarked,
  type Question,
  type QuestionAnswer,
  type QuestionType,
} from '@/features/questions/types';
import { m } from '@/i18n';

export type QuizTemplateId = 'blank' | QuestionType;

/** One example part per answer type: what its tile shows and what the new quiz
 * opens with, to write over. A stored quiz holds only complete questions, so
 * each is one. */
const EXAMPLES: Record<
  QuestionType,
  () => {
    answer: QuestionAnswer;
    marks: number;
    marking?: string[];
    text: string;
  }
> = {
  boolean: () => ({
    answer: { correct: false, type: 'boolean' },
    marks: 1,
    text: m.practice_template_boolean_stem(),
  }),
  drawing: () => ({
    answer: { type: 'drawing' },
    marking: [
      m.practice_template_drawing_mark_1(),
      m.practice_template_drawing_mark_2(),
    ],
    marks: 2,
    text: m.practice_template_drawing_stem(),
  }),
  gaps: () => ({
    answer: {
      accepted: [
        [m.practice_template_gaps_answer_1()],
        [m.practice_template_gaps_answer_2()],
      ],
      type: 'gaps',
    },
    marks: 2,
    text: m.practice_template_gaps_text(),
  }),
  matching: () => ({
    answer: {
      options: [
        m.practice_template_matching_right_1(),
        m.practice_template_matching_right_2(),
        m.practice_template_matching_right_3(),
      ],
      pairs: [
        { left: m.practice_template_matching_left_1(), right: 0 },
        { left: m.practice_template_matching_left_2(), right: 1 },
        { left: m.practice_template_matching_left_3(), right: 2 },
      ],
      type: 'matching',
    },
    marks: 1,
    text: m.practice_template_matching_stem(),
  }),
  mcq: () => ({
    answer: {
      correct: [1],
      options: [
        m.create_preview_quiz_option_1(),
        m.create_preview_quiz_option_2(),
        m.create_preview_quiz_option_3(),
      ],
      type: 'mcq',
    },
    marks: 1,
    text: m.create_preview_quiz_stem(),
  }),
  open: () => ({
    answer: { accepted: [], hints: [], type: 'open' },
    marking: [
      m.practice_template_open_mark_1(),
      m.practice_template_open_mark_2(),
    ],
    marks: 2,
    text: m.practice_template_open_stem(),
  }),
  ordering: () => ({
    answer: {
      items: [
        m.practice_template_ordering_item_1(),
        m.practice_template_ordering_item_2(),
        m.practice_template_ordering_item_3(),
        m.practice_template_ordering_item_4(),
      ],
      type: 'ordering',
    },
    marks: 1,
    text: m.practice_template_ordering_stem(),
  }),
  short: () => ({
    answer: { accepted: [m.practice_template_short_answer()], type: 'short' },
    marks: 1,
    text: m.practice_template_short_stem(),
  }),
};

/** Add practice's Create quiz tiles (Epo 2026-11-11): a blank quiz, then one
 * per answer type. Shared quizzes to start from come later. */
export const QUIZ_TEMPLATES: QuizTemplateId[] = [
  'blank',
  'mcq',
  'boolean',
  'short',
  'open',
  'gaps',
  'matching',
  'ordering',
  'drawing',
];

export const templateLabel = (id: QuizTemplateId) =>
  id === 'blank' ? m.practice_template_blank() : answerLabels[id]();

/** The questions a quiz made from the template starts with. */
export function templateQuestions(id: QuizTemplateId): Question[] {
  if (id === 'blank') return [];
  const { answer, marking, marks, text } = EXAMPLES[id]();
  return [
    {
      id: crypto.randomUUID(),
      labels: 'letters',
      layout: 'paper',
      parts: [
        {
          answer,
          blocks: [{ text, type: 'text' }],
          id: crypto.randomUUID(),
          marks,
          // Only model-marked parts carry a marking scheme, one mark an item.
          ...(modelMarked(answer.type) && marking
            ? { markscheme: marking.map((item) => ({ marks: 1, text: item })) }
            : {}),
          solution: [],
        },
      ],
      stem: [],
    },
  ];
}

/** The tile's picture: the template's question as a quiz card previews one. A
 * gaps stem holds U+0001 where each blank is. */
export function templatePreview(
  id: QuizTemplateId
): QuizPreviewQuestion | undefined {
  if (id === 'blank') return;
  const { answer, text } = EXAMPLES[id]();
  return {
    stem: answer.type === 'gaps' ? text.replace(/\(\d+\) _+/g, '\u0001') : text,
    type: answer.type,
    ...(answer.type === 'mcq' ? { options: answer.options } : {}),
    ...(answer.type === 'matching'
      ? { prompts: answer.pairs.map((pair) => pair.left) }
      : {}),
    ...(answer.type === 'ordering' ? { itemCount: answer.items.length } : {}),
  };
}
