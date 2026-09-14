import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { openEditorNote } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/ui-motion.html');
  await expect(page.getByRole('button', { name: 'Toggle tool' })).toBeVisible();
});

test('custom popup preserves its anchor on exit and survives rapid reopen', async ({
  page,
}) => {
  const toggle = page.getByRole('button', { name: 'Toggle tool' });
  const tool = page.getByTestId('tool');
  await toggle.click();
  await expect(tool).toHaveAttribute('data-state', 'open');
  expect(
    await tool.evaluate((node) => getComputedStyle(node).animationDuration)
  ).toBe('0.25s');
  await page.getByRole('button', { name: 'Move anchor' }).click();
  await expect(tool).toContainText('Moved content');
  const anchor = await tool.evaluate(
    (node) => node.parentElement!.style.transform
  );
  await toggle.evaluate((node) => node.click());
  await expect(tool).toHaveAttribute('data-state', 'closed');
  expect(
    await tool.evaluate((node) => ({
      anchor: node.parentElement!.style.transform,
      duration: getComputedStyle(node).animationDuration,
      inert: node.parentElement!.inert,
    }))
  ).toEqual({ anchor, duration: '0.15s', inert: true });
  await toggle.evaluate((node) => node.click());
  await expect(tool).toHaveAttribute('data-state', 'open');
  await tool.evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations().map((a) => a.finished));
  });
  await expect(tool).toBeVisible();
  await toggle.click();
  await expect(tool).toHaveCount(0);
});

test('menu keyboard navigation skips disabled items and executes once', async ({
  page,
}) => {
  const trigger = page.getByRole('button', { exact: true, name: 'Actions' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('output')).toHaveText('delete');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('text swaps keep outgoing copy hidden from accessibility and read emphasis does not replay', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Change copy' }).click();
  await expect(page.locator('[aria-hidden].motion-copy-out')).toHaveCount(2);
  await page.locator('.motion-text-in').evaluateAll(async (nodes) => {
    await Promise.allSettled(
      nodes.flatMap((node) => node.getAnimations().map((a) => a.finished))
    );
  });
  await expect(page.locator('.motion-copy-out')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark read' }).click();
  expect(
    await page
      .locator('.motion-text-in')
      .evaluateAll(
        (nodes) => nodes.flatMap((node) => node.getAnimations()).length
      )
  ).toBe(0);
  await page.getByRole('button', { name: 'Change copy' }).click();
  await expect(page.locator('[aria-hidden].motion-copy-out')).toHaveCount(2);
});

test('shared primitives use asymmetric popup and drawer tokens', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open popover' }).click();
  const popover = page.locator('[data-slot="popover-content"]');
  expect(
    await popover.evaluate((node) => getComputedStyle(node).animationDuration)
  ).toBe('0.25s');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveAttribute('data-state', 'closed');
  expect(
    await popover.evaluate((node) => getComputedStyle(node).animationDuration)
  ).toBe('0.15s');
  await expect(popover).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Pick option' }).click();
  const select = page.getByRole('listbox');
  expect(
    await select.evaluate((node) => getComputedStyle(node).animationDuration)
  ).toBe('0.25s');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open drawer' }).click();
  const drawer = page.locator('[data-slot="drawer-popup"]');
  expect(
    await drawer.evaluate((node) => getComputedStyle(node).transitionDuration)
  ).toBe('0.4s');
  await page.getByRole('button', { name: 'Close drawer' }).click();
  await expect(drawer).toHaveAttribute('data-ending-style', '');
  expect(
    await drawer.evaluate((node) => getComputedStyle(node).transitionDuration)
  ).toBe('0.35s');
  await expect(drawer).toHaveCount(0);
});

test('reduced motion removes custom popups and outgoing copy without animation events', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const toggle = page.getByRole('button', { name: 'Toggle tool' });
  await toggle.click();
  expect(
    await page
      .getByTestId('tool')
      .evaluate((node) => node.getAnimations().length)
  ).toBe(0);
  await toggle.click();
  await expect(page.getByTestId('tool')).toHaveCount(0);
  await page.getByRole('button', { name: 'Change copy' }).click();
  await expect(page.locator('.motion-copy-out')).toHaveCount(0);
});

test('only new notification IDs arriving in an open panel reveal', async ({
  page,
}) => {
  const bell = page.getByTestId('notices').getByRole('button');
  await bell.click();
  await expect(page.locator('.motion-text-reveal')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Insert notice' })
    .evaluate((node) => node.click());
  await expect(page.locator('.motion-text-reveal')).toHaveCount(1);
  await page.locator('.motion-text-reveal').evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations().map((a) => a.finished));
  });
  await page
    .getByRole('button', { name: 'Refresh notices' })
    .evaluate((node) => node.click());
  expect(
    await page
      .locator('.motion-text-reveal')
      .evaluate((node) => node.getAnimations().length)
  ).toBe(0);
  await page
    .getByRole('button', { name: 'Load earlier notice' })
    .evaluate((node) => node.click());
  await expect(page.locator('.motion-text-reveal')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  await bell.click();
  await expect(page.locator('.motion-text-reveal')).toHaveCount(0);
});

test('closing command content becomes inert before another Enter can execute it', async ({
  page,
}) => {
  const trigger = page.getByRole('button', { exact: true, name: 'Actions' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-slot="menu"]')).toHaveAttribute('inert', '');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('executions')).toHaveText('1');
  await expect(page.locator('[data-slot="menu"]')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('cancelled and nested drawer swipes do not restart blur', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open drawer' }).click();
  const drawer = page.locator('[data-slot="drawer-popup"]');
  const content = page.locator('[data-slot="drawer-content"]');
  await expect(content).toHaveCSS('filter', 'none');
  const handle = await page
    .locator('[data-slot="drawer-swipe-handle"]')
    .boundingBox();
  if (!handle) throw new Error('Missing drawer swipe handle');
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 18, { steps: 8 });
  await expect(drawer).toHaveAttribute('data-swiping', '');
  await expect(content).toHaveCSS('filter', 'none');
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await expect(drawer).not.toHaveAttribute('data-swiping');
  await expect(content).toHaveCSS('filter', 'none');
  expect(await content.evaluate((node) => node.getAnimations().length)).toBe(0);
  await drawer.evaluate(async (node) => {
    node.setAttribute('data-nested-drawer-swiping', '');
    await new Promise(requestAnimationFrame);
    node.removeAttribute('data-nested-drawer-swiping');
    await new Promise(requestAnimationFrame);
  });
  await expect(content).toHaveCSS('filter', 'none');
  expect(await content.evaluate((node) => node.getAnimations().length)).toBe(0);
});

for (const kind of ['dropdown', 'context'] as const) {
  test(`${kind} submenu restores keyboard focus after a rapid reopen`, async ({
    page,
  }) => {
    if (kind === 'dropdown') {
      await page
        .getByRole('button', { exact: true, name: 'Nested actions' })
        .focus();
    } else {
      await page
        .getByRole('button', { exact: true, name: 'Context actions' })
        .click({ button: 'right' });
    }
    await page.keyboard.press('ArrowDown');
    const more = page.getByRole('menuitem', { name: 'More actions' });
    const action = page.getByRole('menuitem', {
      exact: true,
      name: 'Nested action',
    });
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(action).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('executions')).toHaveText('1');
  });
}

test('All blocks toggles closed with a second click and keyboard activation', async ({
  page,
}) => {
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  const trigger = page.getByRole('button', { exact: true, name: 'All blocks' });
  await trigger.click();
  await expect(trigger).toHaveAttribute('data-state', 'open');
  await trigger.click();
  await expect(trigger).toHaveAttribute('data-state', 'closed');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('data-state', 'open');
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('data-state', 'closed');
});

test('AI input regains focus on a rapid reopen', async ({ page }) => {
  // biome-ignore lint/suspicious/noSkippedTests: The menu only exists in builds with this feature enabled.
  test.skip(
    process.env.VITE_FEATURE_EDITOR_AI !== 'true',
    'Enable the editor AI feature for this focus check.'
  );
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  await editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true }).click();
  await page.keyboard.press('ControlOrMeta+j');
  const input = page.getByPlaceholder('Ask AI anything');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+j');
  await expect(input).toBeFocused();
});

test('command palette rapid reopen keeps typing in its search field', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  const paragraph = editor.getByText(EDITOR_NOTE.firstParagraph, {
    exact: true,
  });
  await paragraph.click();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByPlaceholder('Search commands');
  await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input).toBeFocused();
  await page.keyboard.type('zzprobe');
  await expect(input).toHaveValue('zzprobe');
  await expect(paragraph).toHaveText(EDITOR_NOTE.firstParagraph);
});

test('workspace creation opens with a fresh form after cancellation', async ({
  page,
}) => {
  await page.goto('/workspaces');
  const create = page.getByRole('button', {
    exact: true,
    name: 'New workspace',
  });
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'Create workspace' });
  const name = dialog.getByPlaceholder('Workspace name');
  await name.fill('Cancelled draft');
  await expect(
    dialog.getByRole('button', { exact: true, name: 'Create' })
  ).toBeEnabled();
  await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await create.click();
  await expect(name).toHaveValue('');
  await expect(
    dialog.getByRole('button', { exact: true, name: 'Create' })
  ).toBeDisabled();
});
