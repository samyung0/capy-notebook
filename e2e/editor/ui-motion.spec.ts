import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { openEditorNote } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/ui-motion.html');
  await expect(page.getByRole('button', { name: 'Toggle tool' })).toBeVisible();
});

test('custom popup is inert while closing and survives a rapid reopen', async ({
  page,
}) => {
  const toggle = page.getByRole('button', { name: 'Toggle tool' });
  const tool = page.getByTestId('tool');
  await toggle.click();
  await expect(tool).toHaveAttribute('data-state', 'open');
  await toggle.evaluate((node) => node.click());
  await expect(tool).toHaveAttribute('data-state', 'closed');
  expect(await tool.evaluate((node) => node.parentElement!.inert)).toBe(true);
  await toggle.evaluate((node) => node.click());
  await expect(tool).toHaveAttribute('data-state', 'open');
  await tool.evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations().map((a) => a.finished));
  });
  await expect(tool).toBeVisible();
  await toggle.click();
  await expect(tool).toHaveCount(0);
});

for (const mode of ['create', 'edit'] as const) {
  test(`workspace ${mode} tags support autocomplete, wheel scrolling and dismissal`, async ({
    page,
  }) => {
    await page.goto('/workspaces');
    if (mode === 'create') {
      await page
        .getByRole('button', { exact: true, name: 'New workspace' })
        .click();
    } else {
      await page
        .getByRole('button', { exact: true, name: 'Open menu' })
        .first()
        .click();
      await page
        .getByRole('menuitem', { exact: true, name: 'Workspace settings' })
        .click();
    }
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('combobox', { name: 'Tags' });
    await input.click();
    const popup = page.locator('[data-slot="popover-content"]');
    await expect(input).toBeFocused();
    // Force overflow even when the mock catalog has only a few remaining tags.
    await popup.evaluate((node) => {
      node.style.maxHeight = '90px';
    });
    await popup.hover();
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => popup.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await page.mouse.wheel(0, -500);
    await expect.poll(() => popup.evaluate((node) => node.scrollTop)).toBe(0);
    await expect(input).toBeFocused();
    await page.getByRole('option', { exact: true, name: '# Essays' }).click();
    await expect(
      dialog.getByRole('button', { name: 'Remove Essays' })
    ).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('New study tag');
    await input.press('Enter');
    await expect(
      dialog.getByRole('button', { name: 'Remove New study tag' })
    ).toBeVisible();
    await expect(input).toHaveValue('');
    await input.press('ArrowDown');
    const activeId = await input.getAttribute('aria-activedescendant');
    await expect(page.getByRole('option', { selected: true })).toHaveAttribute(
      'id',
      activeId!
    );
    await input.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    await input.click();
    await expect(popup).toHaveAttribute('data-state', 'open');
    await input.press('Tab');
    await expect(popup).toHaveCount(0);
    await input.click();
    await expect(popup).toHaveAttribute('data-state', 'open');
    await dialog
      .getByRole('textbox', { exact: true, name: 'Description' })
      .click();
    await expect(popup).toHaveCount(0);
    if (mode === 'edit') {
      await dialog.getByRole('button', { exact: true, name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
    }
  });
}

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

test('reduced motion removes closed popups and replaced copy at once', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const toggle = page.getByRole('button', { name: 'Toggle tool' });
  await toggle.click();
  await expect(page.getByTestId('tool')).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('tool')).toHaveCount(0);
  await page.getByRole('button', { name: 'Change copy' }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  await expect(page.getByText('Copy', { exact: true })).toHaveCount(0);
});

test('closed command content rejects late events and its trigger can reopen it', async ({
  page,
}) => {
  await page.addStyleTag({
    content:
      '[role="menu"][data-state="closed"] { animation-play-state: paused !important; }',
  });
  const trigger = page.getByRole('button', { exact: true, name: 'Actions' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const action = page.getByRole('menuitem', { name: 'Rename' });
  await expect(action).toBeFocused();
  const retained = await action.elementHandle();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-slot="menu"]')).toHaveAttribute('inert', '');
  await retained!.evaluate((node) => {
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      })
    );
    node.click();
  });
  await expect(page.getByTestId('executions')).toHaveText('1');
  await page.locator('[data-slot="menu"]').evaluate((node) => {
    for (const animation of node.getAnimations()) animation.finish();
  });
  await expect(page.locator('[data-slot="menu"]')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByTestId('executions')).toHaveText('1');
});

for (const kind of ['dropdown', 'context'] as const) {
  test(`${kind} submenu restores keyboard focus after a rapid reopen`, async ({
    page,
  }) => {
    await page.addStyleTag({
      content:
        '[role="menu"][data-state="closed"] { animation-play-state: paused !important; }',
    });
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
    const retained = await action.elementHandle();
    await page.keyboard.press('Enter');
    await expect(
      page.locator(`[data-slot="${kind}-menu-sub-content"]`)
    ).toHaveAttribute('inert', '');
    await retained!.evaluate((node) => {
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        })
      );
      node.click();
    });
    await expect(page.getByTestId('executions')).toHaveText('1');
  });
}

test('All blocks toggles closed with a second click and keyboard activation', async ({
  page,
}) => {
  await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
  await page.setViewportSize({ height: 1000, width: 2560 });
  const toolbar = page.getByRole('toolbar', { name: 'Document formatting' });
  for (const name of [
    'All blocks',
    'Upload media',
    'Import document',
    'Export document',
    'Table controls',
    'Block type',
  ]) {
    const control = toolbar.getByRole('button', { exact: true, name });
    await expect(control).toHaveAttribute('aria-haspopup', 'dialog');
    await control.click();
    await expect(control).toHaveAttribute('data-state', 'open');
    await page.keyboard.press('Escape');
    await expect(control).toHaveAttribute('data-state', 'closed');
  }
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

test('icon chooser tracks browsing and confirms only the current draft', async ({
  page,
}) => {
  await page.goto('/workspaces');
  await page
    .getByRole('button', { exact: true, name: 'New workspace' })
    .click();
  const workspace = page.getByRole('dialog', { name: 'Create one' });
  const preview = workspace.locator('img').first();
  const initialIcon = await preview.getAttribute('src');
  const choose = workspace.getByRole('button', {
    exact: true,
    name: 'Choose icon',
  });
  const picker = page.getByRole('dialog', { exact: true, name: 'Choose icon' });
  const styles = picker.getByRole('navigation', { name: 'Icon style' });
  const gallery = picker.getByRole('region', {
    exact: true,
    name: 'Icon style',
  });
  await choose.click();
  await expect(styles.getByRole('button', { name: /^Waves/ })).toHaveAttribute(
    'aria-current',
    'location'
  );
  await styles.getByRole('button', { name: /^Avataaars/ }).click();
  await expect(
    styles.getByRole('button', { name: /^Avataaars/ })
  ).toHaveAttribute('aria-current', 'location');
  await expect(
    picker.getByRole('heading', { name: 'Avataaars' })
  ).toBeInViewport();
  await gallery.press('End');
  await expect(styles.getByRole('button', { name: /^Waves/ })).toHaveAttribute(
    'aria-current',
    'location'
  );
  await gallery.press('Home');
  await expect(
    styles.getByRole('button', { name: /^Sprouts/ })
  ).toHaveAttribute('aria-current', 'location');
  await picker.getByRole('button', { exact: true, name: 'sprouts-04' }).click();
  await picker.getByRole('button', { exact: true, name: 'Cancel' }).click();
  await expect(picker).toHaveCount(0);
  await expect(preview).toHaveAttribute('src', initialIcon!);

  await page.setViewportSize({ height: 640, width: 320 });
  await choose.click();
  await expect(picker.getByRole('button', { pressed: true })).toHaveAttribute(
    'aria-label',
    initialIcon!.split('/').pop()!.replace('.svg', '')
  );
  await gallery.press('Home');
  await picker.getByRole('button', { exact: true, name: 'sprouts-04' }).click();
  await picker.getByRole('button', { exact: true, name: 'Use icon' }).click();
  await expect(picker).toHaveCount(0);
  await expect(preview).toHaveAttribute('src', '/icons/sprouts-04.svg');
  await choose.click();
  await expect(
    picker.getByRole('button', { exact: true, name: 'sprouts-04' })
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(choose).toBeFocused();
});

test('workspace creation resets cancelled drafts and saves the previewed default icon', async ({
  page,
}) => {
  await page.goto('/workspaces');
  const create = page.getByRole('button', {
    exact: true,
    name: 'New workspace',
  });
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'Create one' });
  const icon = dialog.locator('img').first();
  await expect(icon).toHaveAttribute('src', /\/icons\/waves-\d{2}\.svg$/);
  const initialIcon = await icon.getAttribute('src');
  const name = dialog.getByPlaceholder('Workspace name');
  await name.fill('Cancelled draft');
  await dialog
    .getByRole('textbox', { exact: true, name: 'Description' })
    .fill('Cancelled description');
  await expect(icon).toHaveAttribute('src', initialIcon!);
  await expect(
    dialog.getByRole('button', { exact: true, name: 'Create' })
  ).toBeEnabled();
  await dialog.getByRole('button', { exact: true, name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await create.click();
  await expect(name).toHaveValue('');
  await expect(
    dialog.getByRole('textbox', { exact: true, name: 'Description' })
  ).toHaveValue('');
  await expect(
    dialog.getByRole('button', { exact: true, name: 'Create' })
  ).toBeDisabled();
  await expect(icon).toHaveAttribute('src', /\/icons\/waves-\d{2}\.svg$/);
  const savedIcon = await icon.getAttribute('src');
  await name.fill('Default icon workspace');
  await dialog.getByRole('button', { exact: true, name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /Default icon workspace/ }).locator('img')
  ).toHaveAttribute('src', savedIcon!);
});
