/**
 * Deterministic fixtures for the e2e editor feature matrix
 * (e2e/editor/playwright.editor.config.ts). Loaded into the mock db when
 * VITE_E2E_EDITOR_SEED=true. The matrix runs entirely against MSW: module
 * state lives in the page, so every navigation starts from this pristine seed.
 */

export const EDITOR_WORKSPACE_ID = 'ws_bio';

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
