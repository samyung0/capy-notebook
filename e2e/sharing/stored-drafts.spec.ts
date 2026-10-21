import { randomUUID } from 'node:crypto';
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  WebSocketRoute,
} from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { users } from '../fixtures/seed';
import { uploadSourceFile } from '../helpers/api';
import { expectEditorLive } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';
import { m } from '../i18n';

/**
 * The context's collaboration sockets pass through the test, so going offline
 * closes them for certain and keeps new ones closed until back online.
 */
async function collaborationLink(context: BrowserContext) {
  const port = process.env.E2E_COLLABORATION_PORT;
  let up = true;
  const open: WebSocketRoute[] = [];
  await context.routeWebSocket(
    (url) => url.port === port,
    (socket) => {
      if (!up) {
        void socket.close();
        return;
      }
      open.push(socket, socket.connectToServer());
    }
  );
  return {
    async down(page: Page) {
      up = false;
      await context.setOffline(true);
      for (const socket of open.splice(0)) await socket.close();
      // Chromium's offline emulation does not reliably fire the event.
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    },
    async up(page: Page) {
      up = true;
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    },
  };
}

/** How many rows of a document the owner's device stores, read in `page`
 * (the page's drafts worker answers after every write it was sent). */
async function storedRows(
  page: Page,
  id: string,
  kind: 'file' | 'material' = 'material'
) {
  return page.evaluate(
    async ([actor, document, documentKind]) => {
      const draftsPath = '/src/lib/editDrafts.ts';
      const { draftKey, readDrafts } = await import(draftsPath);
      const rows: unknown[] = await readDrafts(
        draftKey(actor, documentKind, document)
      );
      return rows.length;
    },
    [users.owner, id, kind] as const
  );
}

/** Waits until `page`'s drafts worker answers. The app creates it at start,
 * but under the Vite dev server its module graph (yjs and its chunks) is
 * still loading for a moment; a fetch that fails once the context goes
 * offline fails the worker for the page load, and its sweeps never send. */
async function workerLoaded(page: Page) {
  expect(await storedRows(page, 'worker-loaded')).toBe(0);
}

/** A text source uploaded to `workspaceId` through the API (the e2e
 * stack's memory store serves its bytes under /api/e2e/blobs/). */
async function uploadText(
  api: APIRequestContext,
  workspaceId: string,
  name: string,
  text: string
) {
  const bytes = Buffer.from(text);
  const uploaded = await uploadSourceFile(
    api,
    workspaceId,
    {
      batchId: `stored-drafts-${randomUUID()}`,
      batchTotal: 1,
      contentType: 'text/markdown',
      name,
      sizeBytes: bytes.length,
    },
    bytes
  );
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  return ((await uploaded.json()) as { id: string }).id;
}

test('a note edited offline in a closed tab reaches a co-editor from another page', async ({
  editorPage,
  materialFactory,
  ownerPage,
  seed,
}) => {
  test.setTimeout(120_000);
  const body = 'Stored drafts body';
  const edited = `${body} written offline`;
  const material = await materialFactory.createNote({
    blockId: 'stored-drafts-body',
    body,
    title: 'E2E Stored Drafts',
    workspaceId: seed.editableWorkspace.id,
  });
  const link = await collaborationLink(ownerPage.context());
  await Promise.all([
    openWorkspaceMaterial(ownerPage, seed.editableWorkspace.id, material.id),
    openWorkspaceMaterial(
      editorPage,
      seed.editableWorkspace.id,
      material.id,
      true
    ),
  ]);
  await expectEditorLive(ownerPage);
  await expectEditorLive(editorPage);
  // The owner's other tab, with no editor open.
  const other = await ownerPage.context().newPage();
  await other.goto('/');
  await expect(other.locator('main')).toBeVisible();
  await workerLoaded(other);

  await link.down(ownerPage);
  await expect(
    ownerPage.locator('[data-connection-status="offline"]')
  ).toBeVisible();
  const text = ownerPage
    .locator('[contenteditable="true"]')
    .first()
    .getByText(body, { exact: true });
  const box = await text.boundingBox();
  if (!box) throw new Error('the note body has no layout box');
  await text.click({
    force: true,
    position: { x: Math.max(box.width - 1, 0), y: box.height / 2 },
  });
  await ownerPage.keyboard.type(' written offline');
  await expect(ownerPage.getByText(edited, { exact: true })).toBeVisible();
  // Every key is stored on the device; nothing reached the room.
  expect(await storedRows(ownerPage, material.id)).toBeGreaterThan(1);
  await expect(editorPage.getByText(edited, { exact: true })).toHaveCount(0);

  // The tab closes with its edit unsent, then the browser comes back online
  // on the other page: the co-editor receives the edit, and the owner's
  // drafts go once the service stored it.
  await ownerPage.close();
  await link.up(other);
  await expect(editorPage.getByText(edited, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => storedRows(other, material.id)).toBe(0);
});

test('a text source edited offline in a closed tab reaches a co-editor from another page', async ({
  editorPage,
  ownerApi,
  ownerPage,
  seed,
}) => {
  test.setTimeout(120_000);
  const body = 'Stored drafts source';
  const fileId = await uploadText(
    ownerApi,
    seed.editableWorkspace.id,
    'stored-drafts.md',
    body
  );
  const link = await collaborationLink(ownerPage.context());
  const path = `/workspaces/${seed.editableWorkspace.id}?file=${fileId}&mode=edit`;
  await Promise.all([ownerPage.goto(path), editorPage.goto(path)]);
  const source = (page: Page) =>
    page.getByRole('textbox', { exact: true, name: m.source_edit_raw() });
  await expect(source(ownerPage)).toHaveValue(body, { timeout: 60_000 });
  await expect(source(editorPage)).toHaveValue(body, { timeout: 60_000 });
  const other = await ownerPage.context().newPage();
  await other.goto('/');
  await expect(other.locator('main')).toBeVisible();
  await workerLoaded(other);

  await link.down(ownerPage);
  await source(ownerPage).click();
  await ownerPage.keyboard.press('ControlOrMeta+End');
  await ownerPage.keyboard.type(' written offline');
  await expect(source(ownerPage)).toHaveValue(`${body} written offline`);
  expect(await storedRows(ownerPage, fileId, 'file')).toBeGreaterThan(1);
  await expect(source(editorPage)).toHaveValue(body);

  await ownerPage.close();
  await link.up(other);
  await expect(source(editorPage)).toHaveValue(`${body} written offline`, {
    timeout: 20_000,
  });
  await expect.poll(() => storedRows(other, fileId, 'file')).toBe(0);
});
