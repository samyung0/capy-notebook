import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { expectEditorLive } from '../helpers/editor';
import { m } from '../i18n';

/** The top of an element, in page coordinates. */
const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? -1;

// An embedded quiz shows its own credits inside the note, and the note's
// footer, at the end of its scrolling document and outside the editable
// content, lists the note's sources plus its embed's, and drops the embed's
// once it is removed and saved.
test('a note credits its embedded quiz inside the embed and in its footer', async ({
  ownerPage,
  seed,
}) => {
  const note = seed.creditedNote;
  const footers = (page: Page) =>
    page.locator('footer', { hasText: m.material_attribution_title() });
  const check = async (page: Page) => {
    const embedFooter = footers(page)
      .filter({ hasText: note.quizBook })
      .filter({ hasNotText: note.noteBook });
    const noteFooter = footers(page).filter({ hasText: note.noteBook });
    await expect(embedFooter).toHaveCount(1);
    await expect(noteFooter).toHaveCount(1);
    await expect(noteFooter).toContainText(note.quizBook);
    expect(await top(noteFooter)).toBeGreaterThan(await top(embedFooter));
    expect(
      await noteFooter.evaluate((el) => ({
        editable: !!el.closest('[contenteditable="true"], [data-slate-editor]'),
        scrolls: !!el.closest('.overflow-auto'),
      }))
    ).toEqual({ editable: false, scrolls: true });
  };

  const base = `/workspaces/${seed.privateWorkspace.id}?material=${note.id}`;
  await ownerPage.goto(`${base}&mode=view`);
  await expect(ownerPage.getByText(note.quizPrompt)).toBeVisible();
  await check(ownerPage);

  // The quiz's own page credits it too.
  await ownerPage.goto(`/quizzes/${note.quizId}/attempt`);
  await expect(footers(ownerPage)).toContainText(note.quizBook);

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
  const noteFooter = footers(ownerPage).filter({ hasText: note.noteBook });
  await expect(noteFooter).not.toContainText(note.quizBook, {
    timeout: 20_000,
  });
});
