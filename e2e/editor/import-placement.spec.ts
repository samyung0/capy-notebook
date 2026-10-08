import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { clickTextEnd, openEditorNote } from './helpers';

// The toolbar's Import puts the document where the caret was: on an untouched
// line it splits the line there, as an insert at the caret does, and the caret
// follows the document.
test('Import splits the line at the caret and the caret follows', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  );
  // "First paragraph alpha": the caret before "alpha".
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft', { delay: 20 });
  for (let i = 1; i < 'alpha'.length; i++)
    await page.keyboard.press('ArrowLeft');
  await page
    .getByRole('button', { exact: true, name: m.editor_import() })
    .click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .getByRole('button', { exact: true, name: m.editor_import_md() })
      .click(),
  ]);
  await chooser.setFiles({
    buffer: Buffer.from('Imported line\n'),
    mimeType: 'text/markdown',
    name: 'part.md',
  });

  const imported = editor.getByText('Imported line', { exact: true });
  await expect(imported).toBeVisible();
  const head = editor.getByText('First paragraph', { exact: true });
  const tail = editor.getByText('alpha', { exact: true });
  const top = async (locator: typeof imported) =>
    (await locator.boundingBox())!.y;
  expect(await top(head)).toBeLessThan(await top(imported));
  expect(await top(imported)).toBeLessThan(await top(tail));
  await page.keyboard.type('!');
  await expect(
    editor.getByText('Imported line!', { exact: true })
  ).toBeVisible();
});
