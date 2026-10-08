import { expect, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { clickTextEnd, openEditorNote } from './helpers';

// The note editor root reads as not editable through its `contentEditable`
// property, so React skips walking the whole note to save and restore the
// selection around every commit (hideSelectionFromReact in NoteEditorCore,
// human/frontend/plate-editor.md). That only helps while React decides the
// walk by reading this property; if an upgrade stops reading it, this fails.
test('React consults the editor root contentEditable on a keystroke commit', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  );
  const installed = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      '[data-slate-editor="true"]'
    );
    const own =
      root && Object.getOwnPropertyDescriptor(root, 'contentEditable');
    if (!root || !own?.get) return false;
    const reads: string[] = [];
    (window as unknown as { __reads: string[] }).__reads = reads;
    Object.defineProperty(root, 'contentEditable', {
      configurable: true,
      get() {
        const value = own.get!.call(root) as string;
        reads.push(value);
        return value;
      },
      set: own.set,
    });
    return true;
  });
  expect(installed).toBe(true);

  await page.keyboard.type('x');
  await expect(
    editor.getByText(`${EDITOR_NOTE.firstParagraph}x`, { exact: true })
  ).toBeVisible();
  const reads = await page.evaluate(
    () => (window as unknown as { __reads: string[] }).__reads
  );
  expect(reads.length).toBeGreaterThan(0);
  expect(new Set(reads)).toEqual(new Set(['inherit']));
  // Editing follows the attribute, which stays on.
  await expect(editor).toHaveAttribute('contenteditable', 'true');
});
