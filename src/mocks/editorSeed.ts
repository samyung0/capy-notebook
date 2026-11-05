/**
 * Deterministic fixtures for the e2e editor feature matrix
 * (e2e/editor/playwright.editor.config.ts). Loaded into the mock db when
 * VITE_E2E_EDITOR_SEED=true. The matrix runs entirely against MSW: module
 * state lives in the page, so every navigation starts from this pristine seed.
 */

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
