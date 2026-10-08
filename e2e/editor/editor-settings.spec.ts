import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { expectEditorLive } from '../helpers/editor';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('editor settings keep drafts until Apply, persist the width and keep margin clicks editable', async ({
  page,
}) => {
  // A wide window leaves a margin beside the Half width note.
  await page.setViewportSize({ height: 1000, width: 2560 });
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  const settings = page.getByRole('button', {
    exact: true,
    name: m.editor_prefs_settings(),
  });
  const dialog = page.getByRole('dialog', { name: m.editor_prefs_title() });
  const displaySize = dialog.getByRole('combobox', {
    name: m.editor_prefs_display_size(),
  });
  const chooseWidth = async (width: string) => {
    await displaySize.click();
    await page.getByRole('option', { exact: true, name: width }).click();
  };
  const outer = (await editor.boundingBox())!;
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
  await chooseWidth(m.editor_prefs_full_width());
  await dialog
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  await settings.click();
  await expect(displaySize).toHaveAttribute('data-width', 'half');
  await chooseWidth(m.editor_prefs_full_width());
  await dialog
    .getByRole('tab', { exact: true, name: m.editor_prefs_commands() })
    .click();
  await expect(
    dialog.getByRole('switch', { name: m.editor_prefs_decorations() })
  ).toBeVisible();
  await dialog
    .getByRole('tab', { exact: true, name: m.settings_tab_general() })
    .click();
  await expect(displaySize).toHaveAttribute('data-width', 'full');
  await dialog
    .getByRole('button', { exact: true, name: m.action_apply() })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expectEditorLive(page);
  await settings.click();
  await expect(displaySize).toHaveAttribute('data-width', 'full');
});
