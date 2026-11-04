import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { expectEditorLive } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';

/* Against the real collaboration server (Epo 2026-11-04): opening writes
 * nothing, and a device copy paints a reopened note before its token, then joins
 * the room by difference. */

const paragraph = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});
const cell = (text: string) => ({
  children: [{ children: [{ text }], type: 'p' }],
  type: 'td',
});

/** Holds the note's token requests until the returned release runs. */
async function holdTokens(page: Page, noteId: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/materials/${noteId}/collaboration-token`,
    async (route) => {
      await held;
      await route.fallback();
    }
  );
  return release;
}

test('two people opening a note ending in a table write nothing', async ({
  editorPage,
  ownerApi,
  ownerPage,
  seed,
}) => {
  const workspaceId = seed.privateWorkspace.id;
  const created = await ownerApi.post(
    `/api/workspaces/${workspaceId}/materials`,
    {
      data: {
        content: {
          schemaVersion: 1,
          value: [
            paragraph('intro', 'Results before the table'),
            {
              children: [
                { children: [cell('Trial'), cell('Score')], type: 'tr' },
              ],
              id: 'closing-table',
              type: 'table',
            },
          ],
        },
        kind: 'note',
        title: `E2E Open Writes Nothing ${randomUUID()}`,
      },
    }
  );
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: string; revision: number };
  await Promise.all([
    openWorkspaceMaterial(ownerPage, workspaceId, note.id),
    openWorkspaceMaterial(editorPage, workspaceId, note.id),
  ]);
  await Promise.all([
    expectEditorLive(ownerPage),
    expectEditorLive(editorPage),
  ]);
  // Past the room's store debounce: a write would have reached the projection.
  await ownerPage.waitForTimeout(12_000);
  const read = await ownerApi.get(`/api/materials/${note.id}`);
  const material = (await read.json()) as {
    content: { value: { type: string }[] };
  };
  expect(material.content.value.map((block) => block.type)).toEqual([
    'p',
    'table',
  ]);
});

test('a reopen paints from the device copy before its token, then edits on', async ({
  ownerApi,
  ownerPage,
  seed,
}) => {
  const workspaceId = seed.privateWorkspace.id;
  const body = 'Kept on this device';
  const created = await ownerApi.post(
    `/api/workspaces/${workspaceId}/materials`,
    {
      data: {
        content: {
          schemaVersion: 1,
          value: [paragraph('kept-body', body)],
        },
        kind: 'note',
        title: `E2E Device Copy ${randomUUID()}`,
      },
    }
  );
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: string };
  await openWorkspaceMaterial(ownerPage, workspaceId, note.id);
  await expectEditorLive(ownerPage);
  const editor = ownerPage.locator('[contenteditable="true"]').first();
  await editor.getByText(body, { exact: true }).click();
  await ownerPage.keyboard.press('End');
  await ownerPage.keyboard.type(' and typed');
  await expect(ownerPage.getByTestId('editor-save-state')).toHaveAttribute(
    'data-save-state',
    'saved',
    { timeout: 30_000 }
  );
  const release = await holdTokens(ownerPage, note.id);
  await ownerPage.reload();
  // The copy holds the edit, whatever the projection has reached.
  await expect(
    ownerPage.getByTestId('material-preview').getByText(`${body} and typed`)
  ).toBeVisible({ timeout: 30_000 });
  await expect(editor).toBeHidden();
  release();
  await expectEditorLive(ownerPage);
  await editor.getByText(`${body} and typed`).click();
  await ownerPage.keyboard.press('End');
  await ownerPage.keyboard.type(', then more');
  await expect
    .poll(
      async () =>
        (
          await (await ownerApi.get(`/api/materials/${note.id}`)).text()
        ).includes(`${body} and typed, then more`),
      { timeout: 30_000 }
    )
    .toBe(true);
});
