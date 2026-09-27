import { expect, test } from '@playwright/test';
import type { MaterialDiscussion } from '../../src/api/types';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { editorApi, openEditorNote } from './helpers';

for (const target of ['cursor', 'empty block', 'selected text'] as const) {
  test(`comments attach to ${target}`, async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
    await page.keyboard.press('Home');
    if (target !== 'cursor') {
      await page.keyboard.press('Shift+End');
      if (target === 'empty block') await page.keyboard.press('Backspace');
    }
    await page
      .getByRole('toolbar', { name: 'Document formatting' })
      .getByRole('button', { exact: true, name: 'Comment' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add comment' });
    await dialog.getByRole('textbox').fill(`Review ${target}`);
    await dialog
      .getByRole('button', { exact: true, name: 'Add comment' })
      .click();
    await expect(dialog).toHaveCount(0);

    const { status, body: discussions } = await editorApi<MaterialDiscussion[]>(
      page,
      `/api/materials/${EDITOR_NOTE.id}/discussions`
    );
    expect(status).toBe(200);
    expect(discussions).toHaveLength(1);
    expect(discussions[0].blockId).toBe(`${EDITOR_NOTE.id}:first`);
    if (target === 'selected text') {
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
    await editor.getByRole('button', { name: 'Show 1 comment thread' }).click();
    await expect(
      page.getByText(`Review ${target}`, { exact: true })
    ).toBeVisible();
  });
}
