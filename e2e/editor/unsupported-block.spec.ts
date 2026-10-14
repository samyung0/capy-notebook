import { expect, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { m } from '../i18n';

// Decision 5 (Epo 2026-10-13): a note holding a block this version of Capy
// does not know stays readable and opens read-only. Edit hears why from the
// room (`room-read-only`, `unsupported_block`) and drops to View under a
// strip saying so; View draws the note with the block's text and the
// unsupported notice under it.
test('a note holding a block this version cannot edit opens read-only', async ({
  page,
}) => {
  await page.goto(`/workspaces/${EDITOR_WORKSPACE_ID}`);
  const tree = page.locator('[data-workspace-file-tree]');
  await expect(tree).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async (id) => {
    const dbPath = '/src/mocks/db.ts';
    const db = await import(dbPath);
    const note = db.materials.find((row: { id: string }) => row.id === id);
    note.content.value.push({
      children: [{ text: 'From a later version' }],
      id: 'future',
      type: 'timeline',
    });
  }, EDITOR_NOTE.id);
  await tree
    .getByRole('link', { exact: true, name: EDITOR_NOTE.title })
    .click();
  const mode = page.getByRole('button', {
    exact: true,
    name: m.material_mode(),
  });
  await expect(mode).toBeVisible({ timeout: 30_000 });
  if ((await mode.getAttribute('aria-pressed')) !== 'true') await mode.click();

  await expect(page.getByText(m.editor_unsupported_block_strip())).toBeVisible({
    timeout: 30_000,
  });
  const preview = page.getByTestId('material-preview');
  await expect(preview).toContainText(EDITOR_NOTE.firstParagraph);
  const block = preview.locator('[data-unsupported-block="timeline"]');
  await expect(block).toHaveText(m.material_unsupported_block());
  await expect(preview).toContainText('From a later version');
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
});
