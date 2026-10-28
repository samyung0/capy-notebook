import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { clickTextEnd, openEditorNote } from './helpers';

/**
 * A chat answer copied with the keyboard pastes into a note as note blocks
 * (answerCopy.ts, ChatAnswerPastePlugin): whole blocks from the answer's
 * OpenUI program, a partly selected one read from its DOM.
 */

/** Open the note, then the saved chat whose answer gets copied. */
async function openChat(page: Page, label: string) {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.thirdParagraph
  );
  await page.getByText(label, { exact: true }).first().click();
  await expect(page.locator('[data-ui]').first()).toBeVisible();
  return editor;
}

/** Select from `startText` (at its first occurrence of `from`) to `endText`
 * (after its first occurrence of `to`); whole answer when omitted. */
async function selectAnswer(
  page: Page,
  range?: { start: string; from: string; end: string; to: string }
) {
  await page.evaluate((bounds) => {
    const blocks = [...document.querySelectorAll('[data-ui]')].filter(
      (element) => !element.parentElement?.closest('[data-ui]')
    );
    const selected = document.createRange();
    if (bounds) {
      const textNode = (text: string) => {
        const walker = document.createTreeWalker(blocks[0].parentElement!, 4);
        while (walker.nextNode())
          if (walker.currentNode.textContent?.includes(text))
            return walker.currentNode as Text;
        throw new Error(`No text ${text}`);
      };
      const start = textNode(bounds.start);
      const end = textNode(bounds.end);
      selected.setStart(start, start.data.indexOf(bounds.from));
      selected.setEnd(end, end.data.indexOf(bounds.to) + bounds.to.length);
    } else {
      selected.setStartBefore(blocks[0]);
      selected.setEndAfter(blocks.at(-1)!);
    }
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(selected);
  }, range);
  await page.keyboard.press('ControlOrMeta+C');
}

async function pasteBelowThird(page: Page, editor: Locator) {
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true })
  );
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+V');
}

test.describe('chat answer paste', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a whole answer brings every tab and closed reveal as note blocks', async ({
    page,
  }) => {
    const editor = await openChat(page, 'OpenUI: tabs, steps + reveals');
    await selectAnswer(page);
    await pasteBelowThird(page, editor);

    // The inactive tab's callout and a closed reveal's body come along.
    const callout = editor.locator('.slate-callout');
    await expect(callout).toContainText('Energy required');
    await expect(callout).toContainText(m.editor_callout_info());
    await expect(
      editor.getByText(
        'Passive follows the gradient; active can go against it.'
      )
    ).toBeVisible();
    await expect(
      editor.getByText('Concentration difference', { exact: true })
    ).toBeVisible();
  });

  test('math and fenced code paste as equations and a code block', async ({
    page,
  }) => {
    const editor = await openChat(page, 'OpenUI: prose, code + math');
    await selectAnswer(page);
    await pasteBelowThird(page, editor);

    await expect(editor.locator('.slate-inline_equation')).toHaveCount(1);
    await expect(editor.locator('.slate-equation')).toHaveCount(1);
    await expect(editor.locator('.slate-code_block')).toContainText(
      'def recall(correct, total):'
    );
    await expect(editor.locator('.slate-code_block')).toContainText('Python');

    // Other apps get the HTML without the chat's stylesheet: real bold and
    // each formula once, as its TeX.
    const html = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return (await item.getType('text/html')).text();
    });
    expect(html).toContain('<strong>without looking</strong>');
    expect(html).toContain('$a = c/n$');
  });

  test('a triple-click on the last line copies that paragraph alone', async ({
    page,
  }) => {
    const editor = await openChat(page, 'OpenUI: prose, code + math');
    // Chrome ends this selection in the model label under the answer.
    await page
      .locator('[data-chat-answer]')
      .getByText('思い出してから')
      .click({ clickCount: 3 });
    await page.keyboard.press('ControlOrMeta+C');
    await pasteBelowThird(page, editor);

    await expect(editor.locator('strong', { hasText: '日本語' })).toBeVisible();
    await expect(
      editor.getByText('：思い出してから、ノートで確かめる。')
    ).toBeVisible();
  });

  test('a selection ending inside a callout keeps the callout with the selected text', async ({
    page,
  }) => {
    const editor = await openChat(page, 'OpenUI: overview + citations');
    await selectAnswer(page, {
      end: 'Boundary, instructions',
      from: 'Its parts',
      start: 'smallest unit of life',
      to: 'Boundary,',
    });
    await pasteBelowThird(page, editor);

    await expect(
      editor.getByText('Its parts work together to keep it alive.', {
        exact: true,
      })
    ).toBeVisible();
    const callout = editor.locator('.slate-callout');
    await expect(callout.getByText('Remember the jobs')).toBeVisible();
    await expect(callout.getByText('Boundary,', { exact: true })).toBeVisible();
  });
});
