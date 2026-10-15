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
 * PNG file named `name`, or with `other` a file of that type and size. */
async function paste(
  editor: Locator,
  data: Record<string, string>,
  name?: string,
  other?: { size: number; type: string }
) {
  await editor.evaluate(
    (element, { b64, entries, name, other }) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(entries))
        transfer.setData(type, value);
      if (name) {
        const bytes = other
          ? new Uint8Array(other.size)
          : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        transfer.items.add(
          new File([bytes], name, { type: other?.type ?? 'image/png' })
        );
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
    { b64: PNG_B64, entries: data, name, other }
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

  // Epo 2026-10-15: notes embed images and audio only. Any other file pasted
  // or dropped, whatever its size, is refused in the placeholder it lands in.
  test('a pasted PDF is refused in its placeholder and nothing uploads', async ({
    page,
  }) => {
    await holdUploads(page);
    const editor = await openEmptyLine(page);
    await paste(editor, { 'text/plain': '' }, 'paper.pdf', {
      size: 5 * 1024 * 1024,
      type: 'application/pdf',
    });

    const placeholder = editor.locator('.slate-placeholder');
    await expect(placeholder).toContainText(
      m.editor_choose_purpose({ purpose: m.editor_image() })
    );
    await expect(placeholder).toContainText(m.editor_add_image());
    await expect(placeholder.getByRole('status')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { reservations?: number }).reservations
      )
    ).toBeUndefined();
  });
});

// Epo 2026-10-10: other editors see an upload's skeleton through the
// uploader's presence (src/features/notes/uploadPresence.ts), and the empty
// placeholder again once the uploader leaves; nothing of it is stored.
type Peer = ReturnType<
  typeof import('../../src/mocks/collaboration').mockNotePeer
>;

/** Another editor of the note, headless in the note's mock room. */
async function joinPeer(page: Page) {
  await page.evaluate(async (id) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockNotePeer } = (await import(
      modulePath
    )) as typeof import('../../src/mocks/collaboration');
    Object.assign(window, { peer: mockNotePeer(id) });
  }, EDITOR_NOTE.id);
}

/** The peer starts uploading into a new image placeholder `id`. */
const peerUploads = (page: Page, id: string) =>
  page.evaluate((id) => {
    const peer = (window as unknown as { peer: Peer }).peer;
    peer.awareness.setLocalStateField('uploads', [id]);
    peer.append([
      { children: [{ text: '' }], id, mediaType: 'img', type: 'placeholder' },
    ]);
  }, id);

test.describe('upload presence', () => {
  test("another editor's upload is a skeleton here until it lands, and empty once that editor leaves", async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.thirdParagraph
    );
    await joinPeer(page);
    await peerUploads(page, 'peer-upload');
    const uploading = editor.locator('[data-block-id="peer-upload"]');
    await expect(
      uploading.getByRole('status', { name: m.a11y_loading() })
    ).toBeVisible();
    await expect(uploading).not.toContainText(m.editor_add_image());
    await page.screenshot({
      path: test.info().outputPath('peer-uploading.png'),
    });

    // The peer's upload lands: the image takes the block.
    await page.evaluate(() => {
      const peer = (window as unknown as { peer: Peer }).peer;
      peer.replace('peer-upload', {
        assetId: 'asset_mock_cell_diagram',
        children: [{ text: '' }],
        id: 'peer-upload',
        type: 'img',
      });
      peer.awareness.setLocalStateField('uploads', undefined);
    });
    await expect(
      editor.getByRole('img', { name: 'animal-cell.svg' })
    ).toBeVisible();
    await expect(editor.locator('.slate-placeholder')).toHaveCount(0);

    // Another upload, and the peer leaves before it lands.
    await peerUploads(page, 'peer-left');
    const left = editor.locator('[data-block-id="peer-left"]');
    await expect(left.getByRole('status')).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { peer: Peer }).peer.leave()
    );
    await expect(left).toContainText(m.editor_add_image());
    await expect(left.getByRole('status')).toHaveCount(0);
    await left.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath('peer-left.png'),
    });
  });

  test('this tab names its upload in its presence until the asset id returns', async ({
    page,
  }) => {
    await holdUploads(page);
    const editor = await openEmptyLine(page);
    await joinPeer(page);
    await paste(editor, { 'text/plain': '' }, 'shot.png');
    const placeholder = editor.locator('.slate-placeholder');
    await expect(placeholder.getByRole('status')).toBeVisible();
    const id = await placeholder.getAttribute('data-block-id');
    expect(id).toBeTruthy();
    // What the peer sees of this tab's presence.
    const named = () =>
      page.evaluate((id) => {
        const { awareness } = (window as unknown as { peer: Peer }).peer;
        return [...awareness.getStates()].some(
          ([client, state]) =>
            client !== awareness.clientID &&
            Array.isArray(state.uploads) &&
            state.uploads.includes(id)
        );
      }, id);
    await expect.poll(named).toBe(true);

    await page.evaluate(() =>
      window.dispatchEvent(new Event('release-uploads'))
    );
    await expect(editor.getByRole('img', { name: 'shot.png' })).toBeVisible();
    await expect.poll(named).toBe(false);
  });
});

// Epo 2026-10-10 (main 1be046ea): a DOCX's pictures upload as assets through
// the same flow, so its text and pictures both land.
test("a DOCX's pictures upload as skeletons beside its text", async ({
  page,
}) => {
  await holdUploads(page);
  const editor = await openEmptyLine(page);
  await page
    .getByRole('button', { exact: true, name: m.editor_import() })
    .click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .getByRole('button', { exact: true, name: m.editor_import_docx() })
      .click(),
  ]);
  await chooser.setFiles('e2e/fixtures/files/pictures/two-pictures.docx');

  await expect(editor.getByText('Pictures before')).toBeVisible();
  await expect(editor.getByText('Pictures between')).toBeVisible();
  const placeholders = editor.locator('.slate-placeholder');
  await expect(placeholders).toHaveCount(2);
  await expect(placeholders.getByRole('status')).toHaveCount(2);
  await page.screenshot({
    path: test.info().outputPath('docx-uploading.png'),
  });
  await page.evaluate(() => window.dispatchEvent(new Event('release-uploads')));
  await expect(
    editor.getByRole('img', { name: 'pasted-image.png' })
  ).toHaveCount(2);
  await expect(placeholders).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('docx-uploaded.png') });
});
