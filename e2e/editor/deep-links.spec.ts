import { expect, test } from '@playwright/test';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

/* Links into an item work in the one mode an editor has (Epo 2026-11-04). */

test('a link to a question scrolls to it in the quiz editor', async ({
  page,
}) => {
  await page.setViewportSize({ height: 500, width: 1000 });
  await page.goto('/workspaces/ws_bio?material=qz_1');
  await expect(page.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  const rows = page.locator('[data-question-id]');
  const last = await rows.last().getAttribute('data-question-id');
  await expect(rows.last()).not.toBeInViewport();
  await page.goto(`/workspaces/ws_bio?material=qz_1&item=${last}`);
  await expect(page.locator('[data-question-edit]').first()).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.locator(`[data-question-id="${last}"]`)).toBeInViewport();
});

test("a note's embed answers in Preview from its menu, and edits again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  const embed = page
    .locator('[data-note-mount="live"] .slate-material_ref')
    .first();
  await embed.scrollIntoViewIfNeeded();
  await expect(embed.locator('[data-question-edit]').first()).toBeVisible({
    timeout: 30_000,
  });
  await embed.hover();
  await embed.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page.getByRole('menuitem', { name: m.editor_embed_preview() }).click();
  const answer = embed.getByRole('button', { name: /Mitochondria/ }).first();
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  await embed.hover();
  await embed.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page.getByRole('menuitem', { name: m.action_edit() }).click();
  await expect(embed.locator('[data-question-edit]').first()).toBeVisible();
});
