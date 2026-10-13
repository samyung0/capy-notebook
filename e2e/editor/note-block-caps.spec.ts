import { expect, test } from '@playwright/test';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('note block captions stop silently at 300 characters, and a Mermaid source past 64 KB is refused', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const long = 'c'.repeat(400);
  const kept = 'c'.repeat(300);
  const replaceWithLong = async () => {
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(long);
  };

  // The inline Mermaid caption, edited in place under the diagram.
  const diagram = page.locator('.slate-mermaid').first();
  const caption = diagram.getByRole('textbox', {
    name: m.editor_caption_add(),
  });
  await caption.click();
  await replaceWithLong();
  await expect(caption).toHaveValue(kept);

  // The interactive block's caption, in its source dialog.
  await page
    .getByRole('button', { exact: true, name: m.html_embed_view_source() })
    .first()
    .click();
  const source = page.getByRole('dialog');
  await source.getByLabel(m.html_embed_caption()).click();
  await replaceWithLong();
  await expect(source.getByLabel(m.html_embed_caption())).toHaveValue(kept);
  await source
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  await expect(source).toHaveCount(0);
  await expect(page.getByText(kept, { exact: true })).toBeVisible();

  // The Mermaid source refuses a paste that would take it past 64 KB, with
  // the HTML embed source's message, and takes the next edit that fits.
  await diagram.hover();
  await diagram
    .getByRole('button', { exact: true, name: m.action_edit() })
    .click();
  const dialog = page.getByRole('dialog');
  const code = dialog.getByRole('textbox', { name: m.editor_mermaid_source() });
  await code.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.evaluate(() =>
    navigator.clipboard.writeText(`\n%% ${'d'.repeat(70_000)}`)
  );
  await page.keyboard.press('ControlOrMeta+V');
  await expect(dialog.getByText(m.html_embed_too_large())).toBeVisible();
  await expect(code).not.toContainText('ddd');
  await expect(code).toContainText('ETC --> ATP');
  await page.keyboard.type('\n  ATP --> Done');
  await expect(dialog.getByText(m.html_embed_too_large())).toHaveCount(0);
  await expect(code).toContainText('ATP --> Done');
});
