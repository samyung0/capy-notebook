import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
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
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
});

test('floating add menu stays fixed while scrolling and shares the header actions without click-through', async ({
  page,
}) => {
  const tree = page.locator('[data-workspace-file-tree]');
  const trigger = page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { name: 'Add file' });
  const menu = page.getByRole('menu');
  await tree
    .locator('..')
    .getByRole('button', { exact: true, name: 'Add file' })
    .first()
    .click();
  const headerItems = await menu.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  const before = await trigger.boundingBox();
  await tree.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await trigger.boundingBox()).toEqual(before);
  await tree.evaluate((element) => {
    element.scrollTop = 0;
  });
  const fileBox = await tree
    .getByRole('button', { exact: true, name: 'Cell structure.pdf' })
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
    .getByRole('menuitem', { exact: true, name: 'Add chapter' })
    .click();
  await expect(page.getByRole('dialog', { name: 'New chapter' })).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Cancel' }).click();

  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

// Measure the rendered motion, not just the configured CSS timings.
async function sampleMorph(surface: Locator, action: () => Promise<void>) {
  const sampling = surface.evaluate(
    (element) =>
      new Promise<
        { width: number; height: number; right: number; bottom: number }[]
      >((resolve) => {
        const started = performance.now();
        const frames: {
          width: number;
          height: number;
          right: number;
          bottom: number;
        }[] = [];
        function sample() {
          const { width, height, right, bottom } =
            element.getBoundingClientRect();
          frames.push({ bottom, height, right, width });
          if (performance.now() - started < 900) requestAnimationFrame(sample);
          else resolve(frames);
        }
        requestAnimationFrame(sample);
      })
  );
  await action();
  return sampling;
}

test('floating add surface overshoots on open and nudges then settles on close', async ({
  page,
}) => {
  const surface = page.locator('[data-slot="menu-morph-surface"]');
  const trigger = page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { name: 'Add file' });
  const closed = await surface.boundingBox();
  if (!closed) throw new Error('Floating surface must be visible');
  const opening = await sampleMorph(surface, () => trigger.click());
  const opened = opening.at(-1);
  if (!opened) throw new Error('Opening motion must produce frames');
  expect(Math.max(...opening.map((frame) => frame.width))).toBeGreaterThan(
    opened.width + 1
  );
  expect(Math.max(...opening.map((frame) => frame.height))).toBeGreaterThan(
    opened.height
  );
  expect(opened.right).toBeCloseTo(closed.x + closed.width, 0);
  expect(opened.bottom).toBeCloseTo(closed.y + closed.height, 0);

  const closing = await sampleMorph(surface, () =>
    page.keyboard.press('Escape')
  );
  const settled = closing.at(-1);
  if (!settled) throw new Error('Closing motion must produce frames');
  expect(
    Math.max(...closing.map((frame) => frame.right)) - opened.right
  ).toBeGreaterThan(4);
  expect(
    Math.max(...closing.map((frame) => frame.bottom)) - opened.bottom
  ).toBeGreaterThan(4);
  expect(settled.width).toBeCloseTo(closed.width, 0);
  expect(settled.height).toBeCloseTo(closed.height, 0);
  expect(settled.right).toBeCloseTo(opened.right, 0);
  expect(settled.bottom).toBeCloseTo(opened.bottom, 0);
  await expect(trigger).toBeFocused();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(surface).toHaveCSS('animation-name', 'none');
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
    .getByRole('button', { exact: true, name: 'Collapse all chapters' })
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

test('both sides of an insertion gap keep the line at the same position', async ({
  page,
}) => {
  const tree = page.locator('[data-workspace-file-tree]');
  for (const kind of ['content', 'chapter']) {
    if (kind === 'chapter') {
      await page
        .getByRole('button', { exact: true, name: 'Collapse all chapters' })
        .click();
    }
    const source =
      kind === 'content'
        ? tree.locator('[data-workspace-content-row="file:f_3"]')
        : tree.locator('[data-workspace-chapter="ch_3"] [draggable="true"]');
    const above =
      kind === 'content'
        ? tree.locator('[data-workspace-content-row="file:f_2"]')
        : tree.locator('[data-workspace-chapter="ch_1"]');
    const below =
      kind === 'content'
        ? tree.locator('[data-workspace-content-row="material:mat_1"]')
        : tree.locator('[data-workspace-chapter="ch_2"]');
    const aboveBox = await above.boundingBox();
    if (!aboveBox) throw new Error('Upper row is not visible');
    await dragOver(page, source, above, { x: 45, y: aboveBox.height - 2 });
    const afterLine = above.locator('.border-solid-accent-1');
    await expect(afterLine).toBeVisible();
    const afterBox = await afterLine.boundingBox();
    const belowBox = await below.boundingBox();
    if (!belowBox) throw new Error('Lower row is not visible');
    await page.mouse.move(belowBox.x + 45, belowBox.y + 2, { steps: 4 });
    const beforeLine = below.locator('.border-solid-accent-1');
    await expect(beforeLine).toBeVisible();
    expect(await beforeLine.boundingBox()).toEqual(afterBox);
    await page.mouse.up();
  }
});

test('tree drags suppress grey row backgrounds and action fades until cancellation', async ({
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
    const rows = tree.locator(
      '[data-workspace-content-row] .group, [data-workspace-chapter] > .group'
    );
    await expect
      .poll(() =>
        rows.evaluateAll((elements) =>
          elements.every(
            (element) =>
              getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)'
          )
        )
      )
      .toBe(true);
    const actions = tree.locator('[data-slot="hover-actions"]');
    await expect
      .poll(() =>
        actions.evaluateAll((elements) =>
          elements.every(
            (element) => getComputedStyle(element).display === 'none'
          )
        )
      )
      .toBe(true);
    await expect(
      source.getByRole('button', { includeHidden: true, name: 'Open menu' })
    ).toBeHidden();
    if (selector.includes('content-row'))
      await expect(destination).toHaveClass(/bg-tint-accent-1/);
    else
      await expect(destination.locator('.border-solid-accent-1')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(panel).not.toHaveAttribute('data-dragging');
    await source.hover({ position: { x: 45, y: 12 } });
    const row = selector.includes('content-row')
      ? source.locator('.group').first()
      : source;
    await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(
      source.getByRole('button', { name: 'Open menu' })
    ).toBeVisible();
  }
});
