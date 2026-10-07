import { expect, test } from '@playwright/test';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('top-toolbar formatting keeps the selection toolbar open', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    'mat_note_1',
    'Prokaryotes vs eukaryotes'
  );
  await editor.getByText('cell', { exact: true }).dblclick();
  const floating = page.getByRole('toolbar', {
    name: m.editor_selection_actions(),
  });
  await expect(floating).toBeVisible();
  await floating.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished)
    );
  });
  const top = page.getByRole('toolbar', { name: m.editor_doc_formatting() });
  const actions = [
    ...[m.editor_bold(), m.editor_italic(), m.editor_underline()].map(
      (name) => ({
        control: top.getByRole('button', { exact: true, name }),
        mark: name,
      })
    ),
    {
      control: top.getByRole('button', {
        name: m.editor_font_size_value({ size: '' }),
      }),
    },
    { control: page.getByRole('option', { exact: true, name: '24' }) },
  ];
  for (const { control, mark } of actions) {
    const wasPressed = mark ? await control.getAttribute('aria-pressed') : null;
    const stability = floating.evaluate(async (element) => {
      const states: (string | null)[] = [];
      let detached = false;
      const observer = new MutationObserver((records) => {
        detached ||= !element.isConnected;
        for (const record of records) {
          if (record.target === element && record.type === 'attributes') {
            states.push(record.oldValue, element.getAttribute('data-state'));
          }
        }
      });
      observer.observe(document.body, {
        attributeFilter: ['data-state'],
        attributeOldValue: true,
        attributes: true,
        childList: true,
        subtree: true,
      });
      await new Promise<void>((resolve) => {
        document.addEventListener(
          'click',
          () =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          { once: true }
        );
      });
      observer.disconnect();
      return { closed: states.includes('closed'), detached };
    });
    await control.click();
    expect(await stability).toEqual({
      closed: false,
      detached: false,
    });
    if (mark) {
      await expect(
        floating.getByRole('button', { exact: true, name: mark })
      ).toHaveAttribute('aria-pressed', String(wasPressed !== 'true'));
    }
  }
  await expect(
    top.getByRole('button', {
      exact: true,
      name: m.editor_font_size_value({ size: '24' }),
    })
  ).toBeVisible();
  await editor
    .getByRole('heading', { exact: true, name: 'Prokaryotes vs eukaryotes' })
    .click();
  await expect(floating).toHaveCount(0);
});

for (const name of [m.editor_selection_actions(), m.editor_link_actions()]) {
  test(`${name} scrolls with its text before position updates run`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    const editor = await openEditorNote(
      page,
      'mat_note_1',
      'Prokaryotes vs eukaryotes'
    );
    if (name === m.editor_selection_actions()) {
      await editor.getByText('cell', { exact: true }).dblclick();
    } else {
      await editor.getByRole('link', { name: 'Khan Academy: cells' }).click();
    }
    const toolbar = page.getByRole('toolbar', { name });
    await expect(toolbar).toBeVisible();
    const movement = await toolbar.evaluate((element) => {
      let positioner = element as HTMLElement;
      while (getComputedStyle(positioner).position !== 'absolute') {
        positioner = positioner.parentElement!;
      }
      const selection = window.getSelection()!.getRangeAt(0);
      let scroller = selection.startContainer.parentElement!;
      while (
        scroller.scrollHeight <= scroller.clientHeight ||
        !/auto|scroll/.test(getComputedStyle(scroller).overflowY)
      ) {
        scroller = scroller.parentElement!;
      }
      const beforeToolbar = positioner.getBoundingClientRect().top;
      const beforeText = selection.getBoundingClientRect().top;
      // Same JS task: React/Floating UI cannot catch up between measurements.
      scroller.scrollTop += 60;
      return {
        text: selection.getBoundingClientRect().top - beforeText,
        toolbar: positioner.getBoundingClientRect().top - beforeToolbar,
      };
    });
    expect(movement.text).toBe(-60);
    expect(movement.toolbar).toBeCloseTo(movement.text, 1);
    await expect(toolbar).toBeInViewport();
  });
}
