import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { expectEditorLive } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';

/** A paste through the events a real clipboard fires (e2e/editor/paste.spec.ts). */
async function paste(editor: Locator, data: Record<string, string>) {
  await editor.evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries))
      transfer.setData(type, value);
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
  }, data);
}

type Node = { children?: Node[]; materialId?: string; type?: string };

test.describe('pasted copies', () => {
  // A block copied out of one note names that note's flashcard set; the
  // collaboration service's children pass repoints it to a copy under the
  // note it was pasted into, for every editor of that note.
  test("a flashcard set pasted from another note becomes this note's copy for both editors", async ({
    editorPage,
    materialFactory,
    ownerApi,
    ownerPage,
    seed,
  }) => {
    const workspaceId = seed.editableWorkspace.id;
    const source = await materialFactory.createNote({
      blockId: 'paste-source-body',
      body: 'Paste source',
      title: 'E2E Paste Source',
      workspaceId,
    });
    const target = await materialFactory.createNote({
      blockId: 'paste-target-body',
      body: 'Paste target',
      title: 'E2E Paste Target',
      workspaceId,
    });
    const created = await ownerApi.post(
      `/api/materials/${source.id}/embedded`,
      {
        data: {
          cards: [{ back: 'Pasted back', front: 'Pasted front' }],
          kind: 'flashcards',
        },
      }
    );
    expect(created.status()).toBe(201);
    const set = (await created.json()) as { id: string };

    await Promise.all([
      openWorkspaceMaterial(ownerPage, workspaceId, target.id),
      openWorkspaceMaterial(editorPage, workspaceId, target.id, true),
    ]);
    await expectEditorLive(ownerPage);
    await expectEditorLive(editorPage);
    const editor = ownerPage.locator('[contenteditable="true"]').first();
    const body = editor.getByText('Paste target', { exact: true });
    const box = (await body.boundingBox())!;
    await body.click({ position: { x: box.width - 1, y: box.height / 2 } });
    await ownerPage.keyboard.press('Enter');

    // What Slate puts on the clipboard when copying the block.
    const fragment = await ownerPage.evaluate(
      (json) => btoa(encodeURIComponent(json)),
      JSON.stringify([
        {
          children: [{ text: '' }],
          id: 'pasted-set',
          materialId: set.id,
          refKind: 'flashcards',
          type: 'material_ref',
        },
      ])
    );
    await paste(editor, {
      'application/x-slate-fragment': fragment,
      'text/html': `<div data-slate-fragment="${fragment}">Flashcards</div>`,
      'text/plain': 'Flashcards',
    });

    // Both editors show the set once their block names the note's own copy.
    for (const page of [ownerPage, editorPage])
      await expect(
        page.locator('.slate-material_ref').getByText('Pasted front')
      ).toBeVisible({ timeout: 20_000 });
    // The stored note names the copy, not the source's set.
    const pastedRef = async () => {
      const response = await ownerApi.get(`/api/materials/${target.id}`);
      if (!response.ok()) return '';
      const { content } = (await response.json()) as {
        content: { value: Node[] };
      };
      return (
        content.value.find((node) => node.type === 'material_ref')
          ?.materialId ?? ''
      );
    };
    await expect
      .poll(pastedRef, { timeout: 30_000 })
      .toMatch(new RegExp(`^(?!${set.id}$).+`));
    const copy = await pastedRef();
    const copied = await ownerApi.get(`/api/materials/${copy}`);
    expect(copied.ok()).toBe(true);
    expect(await copied.json()).toMatchObject({
      kind: 'flashcards',
      parentMaterialId: target.id,
    });
    const original = await ownerApi.get(`/api/materials/${set.id}`);
    expect(await original.json()).toMatchObject({
      parentMaterialId: source.id,
    });
  });
});
