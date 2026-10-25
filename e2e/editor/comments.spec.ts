import { expect, type Page, test } from '@playwright/test';
import type { MaterialDiscussion } from '../../src/api/types';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import {
  editorApi,
  openBlockContextMenu,
  openEditorNote,
  selectEditorLine,
} from './helpers';

for (const target of [
  'cursor',
  'empty block',
  'selected text',
  'immediate selection',
  'palette selection',
] as const) {
  test(`comments attach to ${target}`, async ({ page }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    const paragraph = editor.getByText(EDITOR_NOTE.firstParagraph, {
      exact: true,
    });
    await selectEditorLine(page, paragraph);
    if (
      target === 'cursor' ||
      target === 'immediate selection' ||
      target === 'palette selection'
    )
      await page.keyboard.press('ArrowLeft');
    if (target === 'empty block') {
      await page.keyboard.press('Backspace');
      await expect(
        editor.locator('.slate-p').first().locator('[data-slate-string]')
      ).toHaveCount(0);
      await expect(
        editor.getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      ).toBeVisible();
    }
    if (target !== 'selected text') {
      await expect(
        page.getByRole('toolbar', { name: m.editor_selection_actions() })
      ).toBeHidden();
    }
    const commentButton = page
      .getByRole('toolbar', { name: m.editor_doc_formatting() })
      .getByRole('button', { exact: true, name: m.editor_comment() });
    if (target === 'immediate selection') {
      // Open in the same task, before Slate's throttled selectionchange handler.
      await commentButton.evaluate(
        (button, text) => {
          if (!text) throw new Error('Comment text is missing');
          const range = document.createRange();
          range.selectNodeContents(text);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        },
        await paragraph.elementHandle()
      );
    } else if (target === 'palette selection') {
      // Ctrl+K in the same task: the palette, whose input then takes focus,
      // must store the native selection Slate has not synced yet.
      await paragraph.evaluate((text) => {
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            ctrlKey: true,
            key: 'k',
          })
        );
      });
      const palette = page.getByRole('dialog', {
        name: m.editor_command_palette(),
      });
      await palette
        .getByPlaceholder(m.editor_search_commands())
        .fill(m.editor_comment());
      await palette
        .getByRole('button')
        .filter({ has: page.getByText(m.editor_comment(), { exact: true }) })
        .click();
    } else {
      await commentButton.click();
    }
    const dialog = page.getByRole('dialog', { name: m.editor_add_comment() });
    await dialog.getByRole('textbox').fill(`Review ${target}`);
    await dialog
      .getByRole('button', { exact: true, name: m.editor_add_comment() })
      .click();
    await expect(dialog).toHaveCount(0);

    const { status, body: discussions } = await editorApi<MaterialDiscussion[]>(
      page,
      `/api/materials/${EDITOR_NOTE.id}/discussions`
    );
    expect(status).toBe(200);
    expect(discussions).toHaveLength(1);
    expect(discussions[0].blockId).toBe(`${EDITOR_NOTE.id}:first`);
    if (target !== 'cursor' && target !== 'empty block') {
      expect(discussions[0].anchorStart).toBeTruthy();
      expect(discussions[0].anchorEnd).toBeTruthy();
      expect(discussions[0].anchorQuote).toBe(EDITOR_NOTE.firstParagraph);
      await expect(editor.locator('[data-comment-decoration]')).toHaveText(
        EDITOR_NOTE.firstParagraph
      );
    } else {
      expect(discussions[0].anchorStart).toBeUndefined();
      expect(discussions[0].anchorEnd).toBeUndefined();
      expect(discussions[0].anchorQuote).toBe('');
      await expect(editor.locator('[data-comment-decoration]')).toHaveCount(0);
    }
    await editor
      .getByRole('button', { name: m.editor_show_threads({ count: '1' }) })
      .click();
    await expect(
      page.getByText(`Review ${target}`, { exact: true })
    ).toBeVisible();
  });
}

/** A comment on the whole note: no block id (Epo 2026-10-21). */
async function postDocumentComment(page: Page, text: string) {
  const { status } = await editorApi(
    page,
    `/api/materials/${EDITOR_NOTE.id}/discussions`,
    {
      body: {
        anchorVersion: 1,
        text,
      },
      method: 'POST',
    }
  );
  expect(status).toBe(201);
}

const documentThreads = (page: Page, count: number) =>
  page
    .getByRole('toolbar', { name: m.editor_doc_formatting() })
    .getByRole('button', {
      name:
        count === 1
          ? m.editor_show_document_threads({ count: '1' })
          : m.editor_show_document_threads_plural({ count: String(count) }),
    });

test('a removed block’s thread lists at the document root until Undo brings the block back', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  await postDocumentComment(page, 'Whole note remark');
  // A thread on the first paragraph's text; its create refetches both.
  await selectEditorLine(
    page,
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  );
  await page
    .getByRole('toolbar', { name: m.editor_doc_formatting() })
    .getByRole('button', { exact: true, name: m.editor_comment() })
    .click();
  const dialog = page.getByRole('dialog', { name: m.editor_add_comment() });
  await dialog.getByRole('textbox').fill('Review first');
  await dialog
    .getByRole('button', { exact: true, name: m.editor_add_comment() })
    .click();
  await expect(dialog).toHaveCount(0);

  const blockThreads = editor.getByRole('button', {
    name: m.editor_show_threads({ count: '1' }),
  });
  await expect(blockThreads).toBeVisible();
  await documentThreads(page, 1).click();
  const threads = page
    .getByRole('dialog')
    .filter({ hasText: m.editor_document_comments() });
  await expect(threads.getByText('Whole note remark')).toBeVisible();
  await expect(threads.getByText('Review first')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The block menu opens on a collapsed selection.
  await editor.getByText(EDITOR_NOTE.secondParagraph, { exact: true }).click();
  const menu = await openBlockContextMenu(page, EDITOR_NOTE.firstParagraph);
  await menu.getByRole('menuitem', { name: m.action_delete() }).click();
  await expect(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  ).toHaveCount(0);
  await expect(blockThreads).toHaveCount(0);
  await documentThreads(page, 2).click();
  // The removed block's thread with its quoted text, replies included.
  await expect(threads.getByText('Review first')).toBeVisible();
  await expect(
    threads.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  ).toBeVisible();
  await threads
    .getByRole('textbox', { name: m.editor_reply() })
    .first()
    .fill('Still relevant');
  await threads
    .getByRole('textbox', { name: m.editor_reply() })
    .first()
    .press('Enter');
  await expect(threads.getByText('Still relevant')).toBeVisible();
  await page.keyboard.press('Escape');

  await editor.getByText(EDITOR_NOTE.secondParagraph, { exact: true }).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  ).toBeVisible();
  await expect(blockThreads).toBeVisible();
  await expect(documentThreads(page, 1)).toBeVisible();
});

test.describe('at 360 px', () => {
  test.use({ viewport: { height: 740, width: 360 } });

  test('document comments open inside the screen', async ({ page }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    await postDocumentComment(page, 'Whole note remark');
    // Opened again, the note loads the stored thread.
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const button = documentThreads(page, 1);
    await expect(button).toBeInViewport({ ratio: 1 });
    await button.click();
    const threads = page
      .getByRole('dialog')
      .filter({ hasText: m.editor_document_comments() });
    await expect(threads.getByText('Whole note remark')).toBeVisible();
    await expect(threads).toBeInViewport({ ratio: 1 });
  });
});
