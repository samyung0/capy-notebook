import { expect, type Page, test } from '@playwright/test';
import { RUNNING_CHAT } from '../../src/mocks/editorSeed';
import { m } from '../i18n';

const leftPanel = (page: Page) => page.locator('[data-workspace-left-panel]');

// Epo 2026-10-27, T19: a reload comes back to the conversation the chat
// panel showed, and its answer still running streams on, with Stop.
test('a reload reopens a running answer, live with Stop', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto('/workspaces/ws_bio');
  const row = leftPanel(page).getByRole('button', { name: RUNNING_CHAT.title });
  await expect(row.getByRole('status', { name: m.chat_running() })).toBeVisible(
    { timeout: 60_000 }
  );
  await row.click();
  const stop = page.getByRole('button', { name: m.chat_stop() });
  await expect(page.getByText(RUNNING_CHAT.partialAnswer)).toBeVisible();
  await expect(stop).toBeVisible();

  await page.reload();
  // No click: the panel opens the kept conversation and follows its turn.
  await expect(page.getByText(RUNNING_CHAT.question)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(RUNNING_CHAT.partialAnswer)).toBeVisible();
  await stop.click();
  await expect(page.getByText(m.chat_stopped())).toBeVisible();
  await expect(stop).toBeHidden();
});
