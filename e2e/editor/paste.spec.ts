import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { clickTextEnd, openEditorNote } from './helpers';

/** The embedded quiz editor's read of a quiz it edits. */
const QUIZ_EDIT_READ = /^\/api\/quizzes\/([^/]+)\/edit$/;

/**
 * Paste through the same events a real clipboard fires. Slate handles a
 * plain-text paste on `paste` and leaves HTML to `beforeinput`. Custom types
 * such as VS Code's `vscode-editor-data` cannot go through the async clipboard
 * API, so the events carry a DataTransfer built in the page.
 */
async function paste(editor: Locator, data: Record<string, string>) {
  await editor.evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries))
      transfer.setData(type, value);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    element.dispatchEvent(event);
    if (!event.defaultPrevented)
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          inputType: 'insertFromPaste',
        })
      );
  }, data);
}

async function openEmptyLine(page: Page) {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.thirdParagraph
  );
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true })
  );
  await page.keyboard.press('Enter');
  return editor;
}

test.describe('paste', () => {
  test('keeps one paragraph per copied <div> line', async ({ page }) => {
    const editor = await openEmptyLine(page);

    await paste(editor, {
      'text/html': '<div>Paste line one</div><div>Paste line two</div>',
      'text/plain': 'Paste line one\nPaste line two',
    });

    await expect(
      editor.locator('.slate-p', { hasText: /^Paste line one$/ })
    ).toBeVisible();
    await expect(
      editor.locator('.slate-p', { hasText: /^Paste line two$/ })
    ).toBeVisible();
  });

  test('renders markdown copied from VS Code as blocks', async ({ page }) => {
    const editor = await openEmptyLine(page);

    await paste(editor, {
      'text/html': '<div style="font-family: Consolas"><div>x</div></div>',
      'text/plain':
        '## Pasted heading\n\nRun `npm` first\n\n```mermaid\ngraph TD\n  Alpha --> Beta\n```',
      'vscode-editor-data': '{"mode":"markdown"}',
    });

    await expect(
      editor.getByRole('heading', { level: 2, name: 'Pasted heading' })
    ).toBeVisible();
    await expect(editor.locator('code', { hasText: 'npm' })).toBeVisible();
    await expect(
      editor.locator('.slate-mermaid', { hasText: 'Alpha' })
    ).toBeVisible();
  });

  test("makes a quiz block pasted from another note this note's copy", async ({
    page,
  }) => {
    const editor = await openEmptyLine(page);
    // A quiz block copied out of another note, plus one whose quiz is gone.
    const ref = (materialId: string) => ({
      children: [{ text: '' }],
      id: `block-${materialId}`,
      materialId,
      refKind: 'quiz',
      type: 'material_ref',
    });
    const fragment = await page.evaluate(
      (json) => btoa(encodeURIComponent(json)),
      JSON.stringify([ref('mat_embed_bio_note_quiz'), ref('mat_gone')])
    );
    // What Slate puts on the clipboard when copying blocks.
    await paste(editor, {
      'application/x-slate-fragment': fragment,
      'text/html': `<div data-slate-fragment="${fragment}">Quiz</div>`,
      'text/plain': 'Quiz',
    });

    // The copy opens in the block's quiz editor; the unreadable block is removed.
    await expect(
      editor
        .locator('.slate-material_ref')
        .getByRole('button', { name: m.quiz_add_question() })
    ).toBeVisible();
    await expect(editor.locator('.slate-material_ref')).toHaveCount(1);
  });

  test('gives each pasted block of the same quiz its own copy', async ({
    page,
  }) => {
    const edited = new Set<string>();
    page.on('request', (request) => {
      const id = new URL(request.url()).pathname.match(QUIZ_EDIT_READ)?.[1];
      if (id) edited.add(id);
    });
    const editor = await openEmptyLine(page);
    const ref = (id: string) => ({
      children: [{ text: '' }],
      id,
      materialId: 'mat_embed_bio_note_quiz',
      refKind: 'quiz',
      type: 'material_ref',
    });
    const fragment = await page.evaluate(
      (json) => btoa(encodeURIComponent(json)),
      JSON.stringify([ref('block-one'), ref('block-two')])
    );
    await paste(editor, {
      'application/x-slate-fragment': fragment,
      'text/html': `<div data-slate-fragment="${fragment}">Quiz</div>`,
      'text/plain': 'Quiz',
    });

    // Each block edits its own copy: the editor reads a quiz only once the
    // block points at this note's copy, so two distinct reads, neither the
    // original.
    await expect(
      editor
        .locator('.slate-material_ref')
        .getByRole('button', { name: m.quiz_add_question() })
    ).toHaveCount(2);
    expect(
      [...edited].filter((id) => id !== 'mat_embed_bio_note_quiz')
    ).toHaveLength(2);
  });
});
