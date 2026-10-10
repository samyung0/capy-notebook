import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { expectEditorLive } from '../helpers/editor';
import { m } from '../i18n';

/** The top of an element, in page coordinates. */
const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? -1;

// An embedded quiz shows its own credits inside the note behind a collapsed
// "Sources (1)" line, and the note's footer, at the end of its scrolling
// document and outside the editable content, lists the note's sources plus
// its embed's: it drops the embed's once the embed is removed and saved, and
// gets them back on Undo, which also leaves the seed as it found it.
test('a note credits its embedded quiz inside the embed and in its footer', async ({
  ownerPage,
  seed,
}) => {
  const note = seed.creditedNote;
  const footers = (page: Page) =>
    page.locator('footer', { hasText: m.material_attribution_title() });
  const noteFooter = (page: Page) =>
    footers(page).filter({ hasText: note.noteBook });
  /** The item's Sources line, opened: the list it controls credits the quiz. */
  const openSources = async (page: Page) => {
    const sources = page.getByRole('button', {
      name: m.material_attribution_sources({ count: 1 }),
    });
    await expect(sources).toHaveCount(1);
    await expect(sources).toHaveAttribute('aria-expanded', 'false');
    const list = page.locator(
      `[id="${await sources.getAttribute('aria-controls')}"]`
    );
    await expect(list).toBeHidden();
    await sources.click();
    await expect(sources).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();
    await expect(list).toContainText(note.quizBook);
    return sources;
  };
  const check = async (page: Page) => {
    const sources = await openSources(page);
    await expect(noteFooter(page)).toHaveCount(1);
    await expect(noteFooter(page)).toContainText(note.quizBook);
    expect(await top(noteFooter(page))).toBeGreaterThan(await top(sources));
    expect(
      await noteFooter(page).evaluate((el) => ({
        editable: !!el.closest('[contenteditable="true"], [data-slate-editor]'),
        scrolls: !!el.closest('.overflow-auto'),
      }))
    ).toEqual({ editable: false, scrolls: true });
  };

  const base = `/workspaces/${seed.privateWorkspace.id}?material=${note.id}`;
  await ownerPage.goto(`${base}&mode=view`);
  await expect(ownerPage.getByText(note.quizPrompt)).toBeVisible();
  await check(ownerPage);

  // The quiz's own page ends with the same line.
  await ownerPage.goto(`/quizzes/${note.quizId}/attempt`);
  await openSources(ownerPage);

  await ownerPage.goto(`${base}&mode=edit`);
  await expectEditorLive(ownerPage);
  await check(ownerPage);

  // Removing its last question (confirmed) removes the embed; once the note
  // saves, the footer is read again and drops the quiz's credit.
  await ownerPage
    .getByRole('button', { exact: true, name: m.action_remove() })
    .click();
  await ownerPage
    .getByRole('dialog')
    .getByRole('button', { exact: true, name: m.action_remove() })
    .click();
  await expect(noteFooter(ownerPage)).not.toContainText(note.quizBook, {
    timeout: 20_000,
  });

  // Undo brings the embed back, and its credit with it.
  await ownerPage
    .getByRole('button', { exact: true, name: m.editor_undo() })
    .click();
  await expect(ownerPage.getByText(note.quizPrompt)).toBeVisible();
  await expect(noteFooter(ownerPage)).toContainText(note.quizBook, {
    timeout: 20_000,
  });
  await expectEditorLive(ownerPage);
});
