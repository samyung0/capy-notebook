import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';
import { hideScenarioPanel } from './helpers';

// Epo 2026-11-20, as for an item someone was kicked from: a member removed
// from the workspace their page shows sees it unavailable, with one error
// toast "You no longer have access". The mock has no events stream, so how
// the stream goes on without the workspace is eventStream.test.ts's.

const WORKSPACE = 'ws_bio';

/** The workspace refuses this person (its read answers 404) and the removal
 * notification reaches the tab, as the events stream delivers it. */
async function removeMember(page: Page) {
  await page.evaluate(async (id) => {
    const path = '/src/mocks/db.ts';
    const db = await import(path);
    const at = db.workspaces.findIndex((row: { id: string }) => row.id === id);
    if (at >= 0) db.workspaces.splice(at, 1);
    const now = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent('capy:mock-stream', {
        detail: {
          notification: {
            at: now,
            data: { removedAt: now, workspaceId: id, workspaceName: 'Biology' },
            id: `n_removed_${now}`,
            kind: 'workspace_member_removed',
          },
          type: 'created',
        },
      })
    );
  }, WORKSPACE);
}

// Set to a folder to keep the removed member's page at desktop width and at
// 360 px.
const shots = process.env.WORKSPACE_ACCESS_LOST_SCREENSHOTS;

test('a member removed from the open workspace sees it unavailable, with one toast', async ({
  page,
}) => {
  await page.goto(`/workspaces/${WORKSPACE}?material=mat_note_1`);
  await expect(page.getByText('Prokaryotes vs eukaryotes').first()).toBeVisible(
    { timeout: 60_000 }
  );

  await removeMember(page);
  const unavailable = page.getByTestId('private-or-unavailable');
  const toast = page
    .locator('[data-toast]')
    .filter({ hasText: m.editor_access_lost() });
  await expect(unavailable).toBeVisible({ timeout: 15_000 });
  await expect(toast).toHaveCount(1);

  // The notice again (the stream's refusal after it, in a deployment) reads
  // the workspace again and toasts no more: still one toast, not counted up.
  await removeMember(page);
  // Two mock reads' latency, for a toast that must not come.
  await page.waitForTimeout(3000);
  await expect(toast).toHaveCount(1);
  await expect(toast.locator('.tst-count')).toHaveCount(0);
  await expect(unavailable).toBeVisible();

  if (shots) {
    await hideScenarioPanel(page);
    await page.screenshot({ path: `${shots}/removed-member-desktop.png` });
    await page.setViewportSize({ height: 780, width: 360 });
    await expect(unavailable).toBeVisible();
    await expect(toast).toBeVisible();
    await page.screenshot({ path: `${shots}/removed-member-360.png` });
  }
});
