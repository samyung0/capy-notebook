import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { clickTextEnd, openEditorNote } from './helpers';

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
});
