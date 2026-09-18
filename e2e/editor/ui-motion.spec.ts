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

for (const mode of ['create', 'edit'] as const) {
  test(`workspace ${mode} tags support autocomplete and close without flashing`, async ({
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
    await popup.evaluate(async (node) => {
      await Promise.allSettled(
        node.getAnimations().map((animation) => animation.finished)
      );
    });
    const [opacity] = await Promise.all([
      popup.evaluate(
        (node) =>
          new Promise<string>((resolve) => {
            node.addEventListener(
              'animationend',
              () => resolve(getComputedStyle(node).opacity),
              { once: true }
            );
          })
      ),
      dialog.getByRole('textbox', { exact: true, name: 'Description' }).click(),
    ]);
    expect(opacity).toBe('0');
    await expect(popup).toHaveCount(0);
  });
}

test('menu anchor stays fixed while its trigger scales on press', async ({
  page,
}) => {
  const trigger = page.getByRole('button', { exact: true, name: 'Actions' });
  const bounds = await trigger.boundingBox();
  if (!bounds) throw new Error('Missing menu trigger bounds');
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  await page.mouse.down();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect
    .poll(async () => (await trigger.boundingBox())!.width)
    .toBeLessThan(bounds.width - 1);
  const pressed = await menu.evaluate((node) =>
    node.parentElement!.getBoundingClientRect().toJSON()
  );
  if (!pressed) throw new Error('Missing menu bounds');
  expect(pressed.y).toBeCloseTo(bounds.y + bounds.height + 4, 0);
  expect(pressed.width).toBeCloseTo(bounds.width, 0);
  await page.mouse.up();
  await expect
    .poll(async () => (await trigger.boundingBox())!.width)
    .toBeCloseTo(bounds.width, 0);
  const released = await menu.evaluate((node) =>
    node.parentElement!.getBoundingClientRect().toJSON()
  );
  expect(released).toEqual(pressed);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
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

test('workspace filter anchor stays fixed throughout its opening animation', async ({
  page,
}) => {
  await page.goto('/workspaces');
  const trigger = page.getByRole('button', { exact: true, name: 'Filter' });
  await expect(trigger).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ height: 844, width });
    for (let attempt = 0; attempt < 2; attempt++) {
      const frames = page.evaluate(async () => {
        const samples: { x: number; y: number; width: number }[] = [];
        await new Promise<void>((resolve) =>
          document.addEventListener('pointerdown', () => resolve(), {
            once: true,
          })
        );
        const start = performance.now();
        while (performance.now() - start < 650) {
          await new Promise(requestAnimationFrame);
          const menu = document.querySelector(
            '[data-slot="popover-content"][data-state="open"]'
          );
          if (!menu || Number(getComputedStyle(menu).opacity) === 0) continue;
          const rect = menu.parentElement!.getBoundingClientRect();
          if (rect.y < 0) continue;
          samples.push({ width: rect.width, x: rect.x, y: rect.y });
        }
        return samples;
      });
      await trigger.click({ delay: 80 });
      const samples = await frames;
      expect(samples.length).toBeGreaterThan(5);
      for (const dimension of ['x', 'y', 'width'] as const) {
        const values = samples.map((sample) => sample[dimension]);
        expect(
          Math.max(...values) - Math.min(...values),
          JSON.stringify(samples)
        ).toBeLessThan(0.6);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(
        0
      );
    }
  }
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

test('dropdown and popover share entry motion and a quieter exit', async ({
  page,
}) => {
  await page.setViewportSize({ height: 1600, width: 1280 });
  const entries: Record<
    'blur' | 'duration' | 'easing' | 'scale' | 'slide',
    string
  >[] = [];
  for (const name of ['Open popover', 'Actions']) {
    await page.getByRole('button', { exact: true, name }).click();
    const popup = page.locator(
      '[data-slot="popover-content"], [data-slot="menu"]'
    );
    await expect(popup).toHaveAttribute('data-side', 'bottom');
    entries.push(
      await popup.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          blur: style.getPropertyValue('--tw-enter-blur').trim(),
          duration: style.animationDuration,
          easing: style.animationTimingFunction,
          scale: style.getPropertyValue('--tw-enter-scale').trim(),
          slide: style.getPropertyValue('--tw-enter-translate-y').trim(),
        };
      })
    );
    await page.keyboard.press('Escape');
    await expect(popup).toHaveAttribute('data-state', 'closed');
    expect(
      await popup.evaluate((node) => ({
        duration: getComputedStyle(node).animationDuration,
        scale: getComputedStyle(node)
          .getPropertyValue('--tw-exit-scale')
          .trim(),
      }))
    ).toEqual({ duration: '0.15s', scale: '0.99' });
    await expect(popup).toHaveCount(0);
  }
  expect(entries[0]).toMatchObject({
    blur: '2px',
    duration: '0.25s',
    scale: '0.97',
  });
  expect(entries[0].slide).not.toBe('0');
  expect(entries[1]).toEqual(entries[0]);
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

test('workspace settings tabs fit vertically and dialogs settle on whole pixels', async ({
  page,
}) => {
  await page.goto('/workspaces');
  await page
    .getByRole('button', { exact: true, name: 'Open menu' })
    .first()
    .click();
  await page
    .getByRole('menuitem', { exact: true, name: 'Workspace settings' })
    .click();
  const dialog = page.getByRole('dialog', {
    exact: true,
    name: 'Workspace settings',
  });
  for (const viewport of [
    { height: 801, width: 1281 },
    { height: 722, width: 390 },
  ]) {
    await page.setViewportSize(viewport);
    for (const name of [
      'General',
      'Sharing',
      'Indexing',
      'Workspace statistics',
    ]) {
      const button = dialog.getByRole('button', { exact: true, name });
      await button.click();
      const overflow = await button.evaluate((node) => {
        const row = node.parentElement!;
        return {
          client: row.clientHeight,
          scroll: row.scrollHeight,
          scrollWidth: row.scrollWidth,
          width: row.clientWidth,
        };
      });
      expect(overflow.scroll).toBe(overflow.client);
      if (viewport.width === 390)
        expect(overflow.scrollWidth).toBeGreaterThan(overflow.width);
      await dialog.evaluate(async (node) => {
        await Promise.allSettled(
          node.getAnimations().map((animation) => animation.finished)
        );
      });
      const settled = await dialog.evaluate((node) => {
        const { x, y } = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { filter: style.filter, willChange: style.willChange, x, y };
      });
      expect(settled.x).toBe(Math.round(settled.x));
      expect(settled.y).toBe(Math.round(settled.y));
      expect(settled.filter).toBe('none');
      expect(settled.willChange).toBe('transform');
    }
  }
  // Simulate the feature-query rules not applying in an older browser.
  const fallback = await dialog.evaluate((node) => {
    node.classList.remove(
      ...Array.from(node.classList).filter((name) =>
        name.startsWith('supports-')
      )
    );
    const { x, y, width, height } = node.getBoundingClientRect();
    return {
      height,
      translate: getComputedStyle(node).translate,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      width,
      x,
      y,
    };
  });
  expect(fallback.translate).toBe('-50% -50%');
  expect(fallback.x + fallback.width / 2).toBeCloseTo(
    fallback.viewportWidth / 2,
    1
  );
  expect(fallback.y + fallback.height / 2).toBeCloseTo(
    fallback.viewportHeight / 2,
    1
  );
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
  const dialog = page.getByRole('dialog', { name: 'Create workspace' });
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
