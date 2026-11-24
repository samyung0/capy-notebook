/**
 * Deterministic fixtures for the e2e editor feature matrix
 * (e2e/editor/playwright.editor.config.ts). Loaded into the mock db when
 * VITE_E2E_EDITOR_SEED=true. The matrix runs entirely against MSW: module
 * state lives in the page, so every navigation starts from this pristine seed.
 */

import type { Question } from '@/features/questions/types';
import { embeddedQuiz } from './noteContent/helpers';

export const EDITOR_WORKSPACE_ID = 'ws_bio';

/** A conversation whose answer is still running when the page loads: the
 * chat follows it again, and Stop saves it stopped (T19). */
export const RUNNING_CHAT = {
  answerId: 'm_e2e_running_answer',
  id: 'conv_e2e_running',
  partialAnswer: 'Mitochondria turn food into energy the cell can use',
  question: 'What do mitochondria do?',
  title: 'A running answer',
};

export const EDITOR_NOTE = {
  firstParagraph: 'First paragraph alpha',
  headingText: 'Editor matrix heading',
  id: 'mat_e2e_editor',
  secondParagraph: 'Second paragraph beta',
  thirdParagraph: 'Third paragraph gamma',
  title: 'Editor matrix note',
};

export function buildEditorNoteValue() {
  return [
    {
      children: [{ text: EDITOR_NOTE.headingText }],
      id: `${EDITOR_NOTE.id}:title`,
      type: 'h1',
    },
    {
      children: [{ text: EDITOR_NOTE.firstParagraph }],
      id: `${EDITOR_NOTE.id}:first`,
      type: 'p',
    },
    {
      children: [{ text: EDITOR_NOTE.secondParagraph }],
      id: `${EDITOR_NOTE.id}:second`,
      type: 'p',
    },
    {
      children: [{ text: EDITOR_NOTE.thirdParagraph }],
      id: `${EDITOR_NOTE.id}:third`,
      type: 'p',
    },
  ];
}

/** A note ending in a table, its rows and cells without ids, as the room holds
 * a note an agent or an import wrote: opening it must write nothing (`mock-
 * scenario-`: its room can start from a stored state, for two pages at once). */
export const TABLE_END_NOTE = {
  id: 'mock-scenario-table-end',
  title: 'Note ending in a table',
};

export function buildTableEndNoteValue() {
  const cell = (text: string) => ({
    children: [{ children: [{ text }], type: 'p' }],
    type: 'td',
  });
  return [
    {
      children: [{ text: 'Results before the table' }],
      id: `${TABLE_END_NOTE.id}:intro`,
      type: 'p',
    },
    {
      children: [
        { children: [cell('Trial'), cell('Score')], type: 'tr' },
        { children: [cell('One'), cell('Four')], type: 'tr' },
      ],
      id: `${TABLE_END_NOTE.id}:table`,
      type: 'table',
    },
  ];
}

/** A note whose embedded quiz holds a choice question and a drawing part, for
 * Preview with the drawing board's code missing (note-preview-load.spec.ts). */
export const DRAWING_QUIZ_NOTE = {
  choice: 'Which organelle holds a plant cell’s DNA?',
  drawing: 'Sketch an animal cell and label its nucleus.',
  id: 'mat_e2e_drawing_quiz',
  intro: 'A quiz with a drawing part.',
  quizId: 'mat_e2e_drawing_quiz_embed',
  title: 'Drawing quiz note',
};

export function buildDrawingQuizNoteValue() {
  const { choice, drawing, id, intro, quizId } = DRAWING_QUIZ_NOTE;
  const question = (
    name: string,
    text: string,
    answer: Question['parts'][number]['answer']
  ): Question => ({
    id: `${id}:${name}`,
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer,
        blocks: [
          { text, type: 'text' },
          ...(answer.type === 'canvas' ? [{ type: 'canvas' as const }] : []),
        ],
        id: `${id}:${name}:part`,
        marks: 1,
        ...(answer.type === 'canvas'
          ? { markscheme: [{ marks: 1, text: 'The nucleus labelled.' }] }
          : {}),
        solution: [],
      },
    ],
    stem: [],
  });
  return [
    { children: [{ text: intro }], id: `${id}:intro`, type: 'p' },
    embeddedQuiz(id, quizId, {
      questions: [
        question('choice', choice, {
          correct: [0],
          options: ['Nucleus', 'Ribosome', 'Cell wall'],
          type: 'mcq',
        }),
        question('drawing', drawing, { type: 'canvas' }),
      ],
    }),
  ];
}
