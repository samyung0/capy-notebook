import { expect, test } from '@playwright/test';
import type { MaterialDiscussion } from '../../src/api/types';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { editorApi, openEditorNote, selectEditorLine } from './helpers';

for (const target of [
  'cursor',
  'empty block',
  'selected text',
  'immediate selection',
  'palette selection',
] as const) {
  test(`comments attach to ${target}`, async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    const paragraph = editor.getByText(EDITOR_NOTE.firstParagraph, {
      exact: true,
    });
    await selectEditorLine(page, paragraph);
    if (target === 'cursor' || target === 'immediate selection')
      await page.keyboard.press('ArrowLeft');
    if (target === 'empty block') {
      await page.keyboard.press('Backspace');
      await expect(
        editor.locator('.slate-p').first().locator('[data-slate-string]')
      ).toHaveCount(0);
      await expect(
        editor.getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      ).toBeVisible();
    }
    if (target !== 'selected text' && target !== 'palette selection') {
      await expect(
        page.getByRole('toolbar', { name: m.editor_selection_actions() })
      ).toBeHidden();
    }
    const commentButton = page
      .getByRole('toolbar', { name: m.editor_doc_formatting() })
      .getByRole('button', { exact: true, name: m.editor_comment() });
    if (target === 'immediate selection') {
      // Open in the same task, before Slate's throttled selectionchange handler.
      await commentButton.evaluate(
        (button, text) => {
          if (!text) throw new Error('Comment text is missing');
          const range = document.createRange();
          range.selectNodeContents(text);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        },
        await paragraph.elementHandle()
      );
    } else if (target === 'palette selection') {
      await page.keyboard.press('ControlOrMeta+k');
      const palette = page.getByRole('dialog', {
        name: m.editor_command_palette(),
      });
      await palette
        .getByPlaceholder(m.editor_search_commands())
        .fill(m.editor_comment());
      await palette
        .getByRole('button')
        .filter({ has: page.getByText(m.editor_comment(), { exact: true }) })
        .click();
    } else {
      await commentButton.click();
    }
    const dialog = page.getByRole('dialog', { name: m.editor_add_comment() });
    await dialog.getByRole('textbox').fill(`Review ${target}`);
    await dialog
      .getByRole('button', { exact: true, name: m.editor_add_comment() })
      .click();
    await expect(dialog).toHaveCount(0);

    const { status, body: discussions } = await editorApi<MaterialDiscussion[]>(
      page,
      `/api/materials/${EDITOR_NOTE.id}/discussions`
    );
    expect(status).toBe(200);
    expect(discussions).toHaveLength(1);
    expect(discussions[0].blockId).toBe(`${EDITOR_NOTE.id}:first`);
    if (target !== 'cursor' && target !== 'empty block') {
      expect(discussions[0].anchorStart).toBeTruthy();
      expect(discussions[0].anchorEnd).toBeTruthy();
      expect(discussions[0].anchorQuote).toBe(EDITOR_NOTE.firstParagraph);
      await expect(editor.locator('[data-comment-decoration]')).toHaveText(
        EDITOR_NOTE.firstParagraph
      );
    } else {
      expect(discussions[0].anchorStart).toBeUndefined();
      expect(discussions[0].anchorEnd).toBeUndefined();
      expect(discussions[0].anchorQuote).toBe('');
      await expect(editor.locator('[data-comment-decoration]')).toHaveCount(0);
    }
    await editor
      .getByRole('button', { name: m.editor_show_threads({ count: '1' }) })
      .click();
    await expect(
      page.getByText(`Review ${target}`, { exact: true })
    ).toBeVisible();
  });
}
