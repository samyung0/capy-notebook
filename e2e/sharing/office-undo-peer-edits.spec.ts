import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  APIRequestContext,
  FrameLocator,
  Page,
  WebSocketRoute,
} from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { seed } from '../fixtures/seed';
import { uploadSourceFile } from '../helpers/api';
import { officeEditMenu, officeTab } from '../helpers/office';

/*
 * Undo in an Office room, in two browsers on the real stack (Q549, Q624): one
 * person deletes what the other is typing in, the first presses Undo, and both
 * read the typing. One person's socket is held for a moment, so the delete and
 * the typing cross in the room as they do when both act at once on a slow link.
 */

const workspaceId = seed.agentWorkspace.id;
const TYPED = 'QPEERTEXT';
const RUNTIME = 'iframe[src*="office-runtime"]';

const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
type Format = keyof typeof CONTENT_TYPES;

const made: string[] = [];
test.afterEach(async ({ ownerApi }) => {
  for (const path of made.splice(0)) {
    const response = await ownerApi.delete(path);
    expect([204, 404], `${path}: ${response.status()}`).toContain(
      response.status()
    );
  }
});

async function upload(api: APIRequestContext, format: Format) {
  const bytes = readFileSync(`e2e/fixtures/files/basic/lesson.${format}`);
  const uploaded = await uploadSourceFile(
    api,
    workspaceId,
    {
      batchId: `office-undo-${randomUUID()}`,
      batchTotal: 1,
      contentType: CONTENT_TYPES[format],
      name: `${randomUUID().slice(0, 8)}-lesson.${format}`,
      sizeBytes: bytes.length,
    },
    bytes
  );
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  made.push(`/api/files/${id}`);
  return id;
}

async function open(page: Page, fileId: string) {
  await page.goto(
    `/workspaces/${workspaceId}?file=${encodeURIComponent(fileId)}&mode=edit`
  );
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  return page.frameLocator(RUNTIME);
}

/** The page's collaboration sockets through the test: it records what the room
 * sends, and `holdHearing` or `holdSending` keeps frames back until `release`.
 * Set up before the page opens its socket. */
async function roomLink(page: Page) {
  const port = process.env.E2E_COLLABORATION_PORT;
  const heard: Buffer[] = [];
  let hearing: (() => void)[] | null = null;
  let sending: (() => void)[] | null = null;
  await page.context().routeWebSocket(
    (url) => url.port === port,
    (socket: WebSocketRoute) => {
      const room = socket.connectToServer();
      room.onMessage((message) => {
        heard.push(Buffer.from(message as Buffer));
        if (hearing) hearing.push(() => socket.send(message));
        else socket.send(message);
      });
      socket.onMessage((message) => {
        if (sending) sending.push(() => room.send(message));
        else room.send(message);
      });
    }
  );
  return {
    heard: (text: string) => heard.some((frame) => frame.includes(text)),
    holdHearing() {
      hearing = [];
    },
    holdSending() {
      sending = [];
    },
    release() {
      for (const send of [...(hearing ?? []), ...(sending ?? [])]) send();
      hearing = null;
      sending = null;
    },
  };
}

/** The page's uncaught errors and what an error boundary caught, which an engine
 * refusing the document ends in. */
function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('ErrorBoundary'))
      errors.push(message.text());
  });
  return errors;
}

/** A DOCX paragraph in the editor's text mirror, which sits where it is drawn. */
function shown(frame: FrameLocator, text: string) {
  return frame.getByRole('paragraph').filter({ hasText: text });
}

function documentInput(frame: FrameLocator) {
  return frame.getByRole('textbox', { name: 'Document input' });
}

/** Where the fixture's last table cell ("42") is drawn: its last character. */
async function lastCellEnd(frame: FrameLocator) {
  const box = await shown(frame, '42')
    .first()
    .locator('.layout-run')
    .last()
    .boundingBox();
  if (!box) throw new Error('the last cell is not drawn');
  return { x: box.x + box.width - 1, y: box.y + box.height / 2 };
}

/** The caret at the end of the fixture's last table cell. */
async function caretInLastCell(page: Page, frame: FrameLocator) {
  // The editor takes the pointer a moment after its menus arrive; the ribbon's
  // contextual Table tab comes once the caret is in a table.
  await expect(async () => {
    const { x, y } = await lastCellEnd(frame);
    await page.mouse.click(x, y);
    await expect(officeTab(page, 'table')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await documentInput(frame).press('End');
}

/** Picks an item of the editor's menu over the last table cell. */
async function tableMenu(page: Page, frame: FrameLocator, item: string) {
  await caretInLastCell(page, frame);
  const { x, y } = await lastCellEnd(frame);
  await page.mouse.click(x, y, { button: 'right' });
  await frame.getByRole('menuitem', { exact: true, name: item }).click();
}

async function undo(input: ReturnType<FrameLocator['locator']>) {
  await input.focus();
  await input.press('ControlOrMeta+z');
}

/** The PPTX editor draws on a canvas and keeps no text for readers: its pixels,
 * once two reads agree. */
async function slidePixels(frame: FrameLocator) {
  const canvas = frame.getByTestId('pptx-slide-canvas');
  let last = await canvas.screenshot();
  for (let read = 0; read < 20; read++) {
    const next = await canvas.screenshot();
    if (next.equals(last)) return next;
    last = next;
  }
  throw new Error('the slide never settled');
}

/** The fixture's top text box on the first slide (1in,1in on its 10in x 7.5in
 * slide), `clickCount` times. */
async function clickTopBox(frame: FrameLocator, clickCount: number) {
  const canvas = frame.getByTestId('pptx-slide-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the slide canvas takes no pointer');
  await canvas.click({
    clickCount,
    position: { x: box.width * 0.17, y: box.height * 0.155 },
  });
}

test.describe('Undo in an Office room', () => {
  test.describe.configure({ timeout: 300_000 });
  test.use({
    storageState: async ({ baseURL }, use) =>
      use({
        cookies: [],
        origins: [
          {
            localStorage: [
              { name: 'capy.workspace.rightPanel', value: 'false' },
              { name: 'capy.workspace.leftPanel', value: 'false' },
            ],
            origin: baseURL!,
          },
        ],
      }),
  });

  for (const first of ['delete', 'typing'] as const) {
    test(`a deleted DOCX table comes back with the other person's typing, the ${first} reaching the room first`, async ({
      editorPage,
      ownerApi,
      ownerPage,
    }) => {
      const errors = [ownerPage, editorPage].map(pageErrors);
      const undoerLink = await roomLink(ownerPage);
      const peerLink = await roomLink(editorPage);
      const fileId = await upload(ownerApi, 'docx');
      const undoer = await open(ownerPage, fileId);
      const peer = await open(editorPage, fileId);
      // The peer's editor is live: what it types reaches the other.
      await caretInLastCell(editorPage, peer);
      await editorPage.keyboard.insertText('Z');
      await expect(shown(undoer, '42Z').first()).toBeAttached({
        timeout: 30_000,
      });

      if (first === 'delete') peerLink.holdHearing();
      else undoerLink.holdSending();
      await tableMenu(ownerPage, undoer, 'Delete table');
      await expect(shown(undoer, '42Z')).toHaveCount(0);
      await editorPage.keyboard.insertText(TYPED);
      await expect(shown(peer, `42Z${TYPED}`).first()).toBeAttached();
      await expect
        .poll(() => undoerLink.heard(TYPED), { timeout: 30_000 })
        .toBe(true);
      if (first === 'typing') undoerLink.release();

      await undo(documentInput(undoer));
      peerLink.release();
      await expect(shown(undoer, `42Z${TYPED}`).first()).toBeAttached({
        timeout: 30_000,
      });
      await expect(shown(peer, `42Z${TYPED}`).first()).toBeAttached({
        timeout: 30_000,
      });

      // Typing goes on in the restored cell, and a joiner reads it all.
      await caretInLastCell(editorPage, peer);
      await editorPage.keyboard.insertText('X');
      await expect(shown(undoer, `42Z${TYPED}X`).first()).toBeAttached({
        timeout: 30_000,
      });
      await ownerPage.reload();
      await expect(officeEditMenu(ownerPage)).toBeVisible({
        timeout: 120_000,
      });
      await expect(
        shown(ownerPage.frameLocator(RUNTIME), `42Z${TYPED}X`).first()
      ).toBeAttached({ timeout: 30_000 });
      expect(errors.flat()).toEqual([]);
    });
  }

  test("a deleted PPTX shape comes back with the other person's typing", async ({
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const errors = [ownerPage, editorPage].map(pageErrors);
    const undoerLink = await roomLink(ownerPage);
    const peerLink = await roomLink(editorPage);
    const fileId = await upload(ownerApi, 'pptx');
    const undoer = await open(ownerPage, fileId);
    const peer = await open(editorPage, fileId);
    // The peer's editor is live: what it types reaches the other.
    const seeded = await slidePixels(undoer);
    await clickTopBox(peer, 2);
    await peer.getByRole('application').press('End');
    await editorPage.keyboard.insertText('Z');
    await expect
      .poll(async () => (await slidePixels(undoer)).equals(seeded), {
        timeout: 30_000,
      })
      .toBe(false);
    const before = await slidePixels(undoer);

    peerLink.holdHearing();
    await clickTopBox(undoer, 1);
    await undoer.getByRole('application').press('Delete');
    await expect
      .poll(async () => (await slidePixels(undoer)).equals(before))
      .toBe(false);
    const deleted = await slidePixels(undoer);
    await editorPage.keyboard.insertText(TYPED);
    await expect
      .poll(() => undoerLink.heard(TYPED), { timeout: 30_000 })
      .toBe(true);

    await undo(undoer.getByRole('application'));
    peerLink.release();
    // Back with the typing: both draw the same, neither the deleted slide nor
    // the slide before the typing.
    const settled = async () => {
      const [one, other] = [await slidePixels(undoer), await slidePixels(peer)];
      return one.equals(other) && !one.equals(deleted) && !one.equals(before);
    };
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);

    // A joiner draws it too.
    const shownToPeer = await slidePixels(peer);
    await ownerPage.reload();
    await expect(officeEditMenu(ownerPage)).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(
        async () =>
          (await slidePixels(ownerPage.frameLocator(RUNTIME))).equals(
            shownToPeer
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    expect(errors.flat()).toEqual([]);
  });

  test('a row whose cells an Undo removed reads as empty and the document keeps working', async ({
    editorPage,
    ownerApi,
    ownerPage,
  }) => {
    const errors = [ownerPage, editorPage].map(pageErrors);
    const fileId = await upload(ownerApi, 'docx');
    const undoer = await open(ownerPage, fileId);
    const peer = await open(editorPage, fileId);
    const rows = (frame: FrameLocator) => frame.locator('.layout-table-row');
    await expect(rows(undoer)).toHaveCount(2);

    await tableMenu(ownerPage, undoer, 'Insert row below');
    await expect(rows(peer)).toHaveCount(3, { timeout: 30_000 });
    await tableMenu(editorPage, peer, 'Insert row below');
    await expect(rows(undoer)).toHaveCount(4, { timeout: 30_000 });
    await undo(documentInput(undoer));

    // The row stays, a blank line holding nothing the text mirror lists, and
    // typing beside it reaches both editors and a joiner.
    await expect(rows(undoer)).toHaveCount(3, { timeout: 30_000 });
    await expect(rows(peer)).toHaveCount(3, { timeout: 30_000 });
    await caretInLastCell(editorPage, peer);
    await editorPage.keyboard.insertText(TYPED);
    await expect(shown(undoer, `42${TYPED}`).first()).toBeAttached({
      timeout: 30_000,
    });
    await ownerPage.reload();
    await expect(officeEditMenu(ownerPage)).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      shown(ownerPage.frameLocator(RUNTIME), `42${TYPED}`).first()
    ).toBeAttached({ timeout: 30_000 });
    expect(errors.flat()).toEqual([]);
  });
});
