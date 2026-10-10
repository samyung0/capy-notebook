import { expect, type Locator, type Page, test } from '@playwright/test';
import { EDITOR_NOTE } from '../../src/mocks/editorSeed';
import { m } from '../i18n';
import { clickTextEnd, openEditorNote } from './helpers';

// Epo 2026-10-10: an uploading image shows a skeleton placeholder, replaced
// by the image when the asset id returns, whichever way the image came in.

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

/**
 * Before the page loads: the call that completes an editor-asset upload (and
 * returns the asset id) waits for a `release-uploads` event; `refuse` makes
 * the reservation fail as a full storage does. Counts reservations in
 * `window.reservations`. Wraps fetch, which MSW's service worker answers
 * behind.
 */
async function holdUploads(page: Page, refuse = false) {
  await page.addInitScript((refuse) => {
    const original = window.fetch.bind(window);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.addEventListener('release-uploads', () => release());
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url, location.href).pathname;
      if (request.method !== 'POST') return original(input, init);
      const reserving = /\/editor-assets\/uploads$/.test(path);
      const counted = window as unknown as { reservations?: number };
      // An aborted upload's reservation never leaves the page.
      if (reserving && !request.signal.aborted)
        counted.reservations = (counted.reservations ?? 0) + 1;
      if (refuse && reserving)
        return new Response(
          JSON.stringify({
            detail: 'Storage is full.',
            errors: [{ message: 'storage_quota_exceeded', value: {} }],
            status: 403,
            title: 'Forbidden',
          }),
          {
            headers: { 'content-type': 'application/problem+json' },
            status: 403,
          }
        );
      if (/\/editor-assets\/uploads\/[^/]+\/complete$/.test(path))
        await released;
      return original(input, init);
    };
  }, refuse);
}

async function openEmptyLine(page: Page) {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.thirdParagraph
  );
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.thirdParagraph, { exact: true })
  );
  await page.keyboard.press('Enter');
  return editor;
}

/** A clipboard paste (as e2e/editor/paste.spec.ts), optionally carrying a
 * PNG file named `name`. */
async function paste(
  editor: Locator,
  data: Record<string, string>,
  name?: string
) {
  await editor.evaluate(
    (element, { b64, entries, name }) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(entries))
        transfer.setData(type, value);
      if (name) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], name, { type: 'image/png' }));
      }
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      element.dispatchEvent(event);
      if (!event.defaultPrevented)
        element.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            inputType: 'insertFromPaste',
          })
        );
    },
    { b64: PNG_B64, entries: data, name }
  );
}

const ways: [string, string, (page: Page, editor: Locator) => Promise<void>][] =
  [
    [
      'a pasted image file',
      'shot.png',
      (_, editor) => paste(editor, { 'text/plain': '' }, 'shot.png'),
    ],
    [
      'a pasted image file with its <img> (Copy image)',
      'copied.png',
      (_, editor) =>
        paste(
          editor,
          { 'text/html': `<img src="https://cdn.example/copied.png">` },
          'copied.png'
        ),
    ],
    [
      'pasted HTML with an <img>',
      'pasted-image.png',
      (_, editor) =>
        paste(editor, {
          'text/html': `<p>Before</p><img src="${PNG_DATA_URL}"><p>After</p>`,
          'text/plain': 'Before After',
        }),
    ],
    [
      'a pasted markdown image',
      'pasted-image.png',
      (_, editor) =>
        paste(editor, {
          'text/plain': `Before\n\n![Figure](${PNG_DATA_URL})\n\nAfter`,
        }),
    ],
    [
      'a dropped image file',
      'dropped.png',
      async (page, editor) => {
        const target = editor.getByText(EDITOR_NOTE.thirdParagraph, {
          exact: true,
        });
        const box = (await target.boundingBox())!;
        const dataTransfer = await page.evaluateHandle((b64) => {
          const transfer = new DataTransfer();
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          transfer.items.add(
            new File([bytes], 'dropped.png', { type: 'image/png' })
          );
          return transfer;
        }, PNG_B64);
        const at = {
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
          dataTransfer,
        };
        for (const type of ['dragenter', 'dragover', 'drop'])
          await target.dispatchEvent(type, at);
      },
    ],
    [
      'an image picked from the toolbar',
      'picked.png',
      async (page, editor) => {
        await page
          .getByRole('button', { exact: true, name: m.editor_media_upload() })
          .click();
        await page
          .getByRole('button', { exact: true, name: m.editor_upload_image() })
          .click();
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          editor.locator('.slate-placeholder [role="button"]').click(),
        ]);
        await chooser.setFiles({
          buffer: Buffer.from(PNG_B64, 'base64'),
          mimeType: 'image/png',
          name: 'picked.png',
        });
      },
    ],
  ];

test.describe('upload placeholder', () => {
  for (const [way, name, add] of ways)
    test(`${way} is a skeleton until its asset id returns`, async ({
      page,
    }) => {
      await holdUploads(page);
      const editor = await openEmptyLine(page);
      await add(page, editor);

      const placeholder = editor.locator('.slate-placeholder');
      const skeleton = placeholder.getByRole('status', {
        name: m.a11y_loading(),
      });
      await expect(skeleton).toHaveCount(1);
      await expect(placeholder).toHaveCount(1);
      await expect(placeholder).not.toContainText(m.editor_add_image());
      await expect(editor.locator('.slate-img')).toHaveCount(0);
      const slug = way.replace(/\W+/g, '-');
      await page.screenshot({
        path: test.info().outputPath(`${slug}-uploading.png`),
      });

      await page.evaluate(() =>
        window.dispatchEvent(new Event('release-uploads'))
      );
      await expect(editor.getByRole('img', { name })).toBeVisible();
      await expect(placeholder).toHaveCount(0);
      await expect(editor.locator('.slate-img')).toHaveCount(1);
      // One upload: nothing restarted it or uploaded the image twice.
      expect(
        await page.evaluate(
          () => (window as unknown as { reservations?: number }).reservations
        )
      ).toBe(1);
      await page.screenshot({
        path: test.info().outputPath(`${slug}-uploaded.png`),
      });
    });

  // A refused upload leaves the empty placeholder to pick again, and the
  // storage notice says why.
  test('a refused upload leaves the empty placeholder and says why', async ({
    page,
  }) => {
    await holdUploads(page, true);
    const editor = await openEmptyLine(page);
    await paste(editor, { 'text/plain': '' }, 'shot.png');

    const placeholder = editor.locator('.slate-placeholder');
    await expect(page.getByText(m.error_quota_title())).toBeVisible();
    await expect(placeholder).toContainText(m.editor_add_image());
    await expect(placeholder.getByRole('status')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('refused-upload.png'),
    });
  });
});
