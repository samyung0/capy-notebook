import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Interactive Plate is a lazy chunk the dev server transforms on demand, so a
 * resolved navigation says nothing about whether the editor has mounted. The
 * budget covers that transform; the default expect timeout does not once
 * several workers open the editor at once.
 *
 * `Synced` is the handshake state and `Saved` follows the first acknowledged
 * checkpoint, so either one means the editor is live — asserting on `Synced`
 * alone races any document that has already checkpointed.
 */
export async function expectEditorLive(page: Page): Promise<void> {
  await expect(page.getByTestId('editor-save-state')).toHaveText(
    /^(Synced|Saved)$/,
    { timeout: 60_000 }
  );
}

/**
 * Static Plate preview is a lazy chunk. Wait for the preview root to mount
 * (chunk loaded + document parsed), then assert text inside it — not "this
 * string appears somewhere within N seconds." The timeout is the test budget,
 * not a guessed transform duration.
 */
export async function expectStaticPreview(
  page: Page,
  text: string
): Promise<void> {
  const preview = page.getByTestId('material-preview');
  await expect(preview).toBeVisible({ timeout: test.info().timeout });
  await expect(preview.getByText(text)).toBeVisible();
}

export function formattingToolbar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'Document formatting' });
}

export function allBlocksMenu(page: Page): Locator {
  return page.locator('[data-all-blocks-menu]');
}

export async function openAllBlocks(page: Page): Promise<Locator> {
  await formattingToolbar(page)
    .getByRole('button', { name: 'All blocks' })
    .click();
  const menu = allBlocksMenu(page);
  await menu.waitFor({ state: 'visible' });
  return menu;
}

export async function chooseAllBlocksEntry(
  page: Page,
  name: string
): Promise<void> {
  const menu = await openAllBlocks(page);
  await menu.getByRole('button', { exact: true, name }).click();
}
