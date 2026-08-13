import { expect, test } from '../fixtures/actors';
import { expectEditorLive } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';

test.describe('live Yjs collaboration', () => {
  test('two editors converge, expose remote selections, and project to static view', async ({
    editorPage,
    materialFactory,
    ownerApi,
    ownerPage,
    seed,
  }) => {
    const body = 'Shared live document';
    const suffix = ' converged';
    const material = await materialFactory.createNote({
      blockId: 'live-convergence-body',
      body,
      title: 'E2E Live Convergence',
      workspaceId: seed.editableWorkspace.id,
    });

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

    const editor = editorPage.locator('[contenteditable="true"]').first();
    const bodyText = editor.getByText(body, { exact: true });
    await bodyText.dblclick();
    await expect(
      ownerPage.locator('[data-remote-cursor="E2E Editor"]')
    ).toBeVisible();

    // Click the end of this paragraph. Bare End is native caret movement that
    // Slate only learns about through a throttled selectionchange listener, so
    // awareness re-renders restore a stale caret. Mod+End goes through Plate
    // but inserts a new block. An out-of-span click is intercepted by <html>.
    const box = await bodyText.boundingBox();
    if (!box) {
      throw new Error('live document body has no layout box');
    }
    await bodyText.click({
      force: true,
      position: { x: Math.max(box.width - 1, 0), y: box.height / 2 },
    });
    await editorPage.keyboard.type(suffix);
    // Assert locally first: a caret that never reached the end is a typing
    // failure, not the convergence failure the next assertion reports.
    await expect(
      editorPage.getByText(`${body}${suffix}`, { exact: true })
    ).toBeVisible();
    await expect(
      ownerPage.getByText(`${body}${suffix}`, { exact: true })
    ).toBeVisible();
    // Durability is the client's 1s checkpoint debounce plus the sidecar's store
    // debounce, which stretches to COLLABORATION_MAX_DEBOUNCE_MS (10s) under
    // continuous updates. The default 10s expect budget cannot cover that.
    await expect(editorPage.getByText('Saved', { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // Projection completion invalidates the material query before static mode.
    await expect
      .poll(async () => {
        const response = await ownerApi.get(`/api/materials/${material.id}`);
        return response.ok() ? await response.text() : '';
      })
      .toContain(`${body}${suffix}`);

    const modes = ownerPage.getByRole('combobox', { name: 'Material mode' });
    await modes.click();
    await ownerPage.getByRole('option', { name: 'View' }).click();
    await expect(
      ownerPage.getByText(`${body}${suffix}`, { exact: true })
    ).toBeVisible();
    await expect(ownerPage.locator('[contenteditable="true"]')).toHaveCount(0);
  });
});
