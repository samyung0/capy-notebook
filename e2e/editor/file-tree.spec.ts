import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { editorApi, openEditorNote } from './helpers';

// Use real pointer drags: synthetic DragEvents miss the editor backend
// cancelling native drags at window level.
async function dragOver(
  page: Page,
  source: Locator,
  target: Locator,
  position: { x: number; y: number }
) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Drag source or target is not visible');
  await page.mouse.move(from.x + 35, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 45, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + position.x, to.y + position.y, { steps: 10 });
  await page.mouse.move(to.x + position.x, to.y + position.y, { steps: 2 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ height: 1100, width: 1440 });
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await page
    .getByRole('button', { exact: true, name: m.workspace_tab_files() })
    .click();
});

test('floating add menu shares the header actions and dismisses without click-through', async ({
  page,
}) => {
  const tree = page.locator('[data-workspace-file-tree]');
  const trigger = page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { name: m.action_add_file() });
  const menu = page.getByRole('menu');
  await tree
    .locator('..')
    .getByRole('button', { exact: true, name: m.action_add_file() })
    .first()
    .click();
  const headerItems = await menu.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  const fileBox = await tree
    .getByRole('link', { exact: true, name: 'Cell structure.pdf' })
    .boundingBox();
  if (!fileBox) throw new Error('File row must be visible');
  const openItemUrl = page.url();
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await menu.getByRole('menuitem').allTextContents()).toEqual(
    headerItems
  );
  // A real outside click must dismiss without opening the file underneath.
  await page.mouse.click(fileBox.x + 20, fileBox.y + fileBox.height / 2);
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(openItemUrl);
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
  await trigger.click();
  await expect(menu).toBeVisible();
  await menu
    .getByRole('menuitem', { exact: true, name: m.action_add_chapter() })
    .click();
  await expect(
    page.getByRole('dialog', { name: m.chapter_new() })
  ).toBeVisible();
  await page
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();

  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('files and materials move between chapters, reorder together, and unfile on the outer tree', async ({
  page,
}) => {
  const tree = page.locator('[data-workspace-file-tree]');
  const panel = tree.locator('..');
  const chapter = (id: string) =>
    tree.locator(`[data-workspace-chapter="${id}"]`);
  const row = (key: string) =>
    tree.locator(`[data-workspace-content-row="${key}"]`);
  const file = row('file:f_1');
  const material = row('material:mat_1');
  const destination = chapter('ch_2');

  // A collapsed chapter accepts content and opens after the drop.
  await destination
    .getByRole('button', { exact: true, name: 'Membranes & transport' })
    .click();
  await dragOver(page, file, destination, { x: 45, y: 12 });
  await expect(destination).toHaveClass(/bg-tint-accent-1/);
  await expect(panel).not.toHaveClass(/outline-2/);
  await page.mouse.up();
  await expect(
    destination.locator('[data-workspace-content-row="file:f_1"]')
  ).toBeVisible();

  await dragOver(page, material, file, { x: 45, y: 2 });
  await expect(file.locator('.border-solid-accent-1')).toHaveClass(/top-0/);
  await expect(destination).not.toHaveClass(/bg-tint-accent-1/);
  await page.mouse.up();
  await expect
    .poll(async () => {
      const rows = await destination
        .locator('[data-workspace-content-row]')
        .evaluateAll((items) =>
          items.map((r) => r.getAttribute('data-workspace-content-row'))
        );
      return rows.indexOf('material:mat_1') + 1 === rows.indexOf('file:f_1');
    })
    .toBe(true);

  // Reorder downward across the same mixed list.
  await dragOver(page, material, file, { x: 45, y: 25 });
  await expect(file.locator('.border-solid-accent-1')).toHaveClass(/bottom-0/);
  await page.mouse.up();
  await expect
    .poll(async () => {
      const rows = await destination
        .locator('[data-workspace-content-row]')
        .evaluateAll((items) =>
          items.map((r) => r.getAttribute('data-workspace-content-row'))
        );
      return rows.indexOf('file:f_1') + 1 === rows.indexOf('material:mat_1');
    })
    .toBe(true);

  // The outer gutter is outside every chapter even when all rows fill the tree.
  for (const item of [file, material]) {
    await dragOver(page, item, tree, { x: 3, y: 45 });
    await expect(panel).toHaveClass(/outline-2 outline-solid-accent-1/);
    await page.mouse.up();
    await expect(
      destination.locator(
        `[data-workspace-content-row="${await item.getAttribute('data-workspace-content-row')}"]`
      )
    ).toHaveCount(0);
    await expect(panel).not.toHaveClass(/outline-2/);
  }
  for (const [kind, id] of [
    ['files', 'f_1'],
    ['materials', 'mat_1'],
  ]) {
    await expect
      .poll(async () => {
        const result = await editorApi<
          { id: string; chapterId: string | null }[]
        >(page, `/api/workspaces/${EDITOR_WORKSPACE_ID}/${kind}`);
        return result.body.find((item) => item.id === id)?.chapterId;
      })
      .toBeNull();
  }
});

test('chapters reorder in both directions while a note editor is open', async ({
  page,
}) => {
  const tree = page.locator('[data-workspace-file-tree]');
  const chapters = tree.locator('[data-workspace-chapter]');
  await page
    .getByRole('button', { exact: true, name: m.workspace_collapse_chapters() })
    .click();
  const first = tree.locator('[data-workspace-chapter="ch_1"]');
  const last = tree.locator('[data-workspace-chapter="ch_3"]');
  await dragOver(page, last.locator('[draggable="true"]'), first, {
    x: 45,
    y: 2,
  });
  await expect(first.locator('.border-solid-accent-1')).toHaveClass(/top-0/);
  await page.mouse.up();
  await expect(chapters.first()).toHaveAttribute(
    'data-workspace-chapter',
    'ch_3'
  );
  const second = tree.locator('[data-workspace-chapter="ch_2"]');
  await dragOver(page, last.locator('[draggable="true"]'), second, {
    x: 45,
    y: 25,
  });
  await expect(second.locator('.border-solid-accent-1')).toHaveClass(
    /bottom-0/
  );
  await page.mouse.up();
  await expect(chapters.last()).toHaveAttribute(
    'data-workspace-chapter',
    'ch_3'
  );
  await expect(tree.locator('.border-solid-accent-1')).toHaveCount(0);
});

test('tree drags hide row actions until Escape cancels them', async ({
  page,
}) => {
  const tree = page.locator('[data-workspace-file-tree]');
  const panel = tree.locator('..');
  const destination = tree.locator('[data-workspace-chapter="ch_2"]');
  for (const selector of [
    '[data-workspace-content-row="file:f_1"]',
    '[data-workspace-content-row="material:mat_1"]',
    '[data-workspace-chapter="ch_3"] > [draggable="true"]',
  ]) {
    const source = tree.locator(selector);
    await dragOver(page, source, destination, { x: 45, y: 12 });
    await expect(panel).toHaveAttribute('data-dragging', 'true');
    await expect(
      source.getByRole('button', {
        includeHidden: true,
        name: m.a11y_open_menu(),
      })
    ).toBeHidden();
    if (selector.includes('content-row'))
      await expect(destination).toHaveClass(/bg-tint-accent-1/);
    else
      await expect(destination.locator('.border-solid-accent-1')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(panel).not.toHaveAttribute('data-dragging');
    await source.hover({ position: { x: 45, y: 12 } });
    await expect(
      source.getByRole('button', { name: m.a11y_open_menu() })
    ).toBeVisible();
  }
});
