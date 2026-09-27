import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { expectEditorLive } from '../helpers/editor';
import { openEditorNote } from './helpers';

test('editor settings preserve width, fill small screens and keep margin clicks editable', async ({
  page,
}) => {
  await page.setViewportSize({ height: 1000, width: 2560 });
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  const content = editor.locator('[data-note-content]');
  const settings = page.getByRole('button', {
    exact: true,
    name: 'Editor settings',
  });
  const dialog = page.getByRole('dialog', { name: 'Editor settings' });
  const chooseWidth = async (width: string) => {
    await dialog.getByRole('combobox', { name: 'Display size' }).click();
    await page.getByRole('option', { exact: true, name: width }).click();
  };
  const fullWidth = async () => {
    await expect
      .poll(() =>
        content.evaluate((element) =>
          Math.abs(
            element.parentElement!.getBoundingClientRect().width -
              element.getBoundingClientRect().width
          )
        )
      )
      .toBeLessThan(1);
  };
  await expect(content).toHaveCSS('max-width', '768px');
  const outer = (await editor.boundingBox())!;
  const inner = (await content.boundingBox())!;
  expect(outer.width).toBeGreaterThan(inner.width + 100);
  const paragraph = editor.getByText(EDITOR_NOTE.firstParagraph, {
    exact: true,
  });
  await paragraph.click();
  const line = (await paragraph.boundingBox())!;
  await page.keyboard.press('End');
  await page.keyboard.type(' margin undo probe');
  await page.mouse.click(outer.x + 10, line.y + line.height / 2);
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).not.toContainText('margin undo probe');

  await settings.click();
  await chooseWidth('Full width');
  await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
  await settings.click();
  await expect(
    dialog.getByRole('combobox', { name: 'Display size' })
  ).toHaveText('Half width');
  await chooseWidth('Full width');
  await dialog.getByRole('button', { exact: true, name: 'Commands' }).click();
  await expect(
    dialog.getByRole('switch', { name: /Text decorations/ })
  ).toBeVisible();
  await dialog.getByRole('button', { exact: true, name: 'General' }).click();
  await expect(
    dialog.getByRole('combobox', { name: 'Display size' })
  ).toHaveText('Full width');
  await dialog.getByRole('button', { exact: true, name: 'Apply' }).click();
  await fullWidth();
  await page.reload();
  await expectEditorLive(page);
  await expect(content).toBeVisible();
  await fullWidth();

  await settings.click();
  await chooseWidth('Half width');
  await dialog.getByRole('button', { exact: true, name: 'Apply' }).click();
  await expect(content).toHaveCSS('max-width', '768px');
  await page.setViewportSize({ height: 900, width: 700 });
  await fullWidth();
  await settings.click();
  await chooseWidth('Full width');
  await dialog.getByRole('button', { exact: true, name: 'Apply' }).click();
  await fullWidth();
  await page.setViewportSize({ height: 1000, width: 2560 });
  await page
    .getByRole('button', { exact: true, name: 'Material mode' })
    .click();
  const preview = page.getByTestId('material-preview').locator('.note-editor');
  await expect(preview).toHaveCSS('max-width', 'none');
});
