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
    await editor.getByText(body, { exact: true }).dblclick();
    await expect(
      ownerPage.locator('[data-remote-cursor="E2E Editor"]')
    ).toBeVisible();

    // Bare End is native caret movement, and Slate only learns about it through
    // a selectionchange listener throttled at 100ms. Awareness traffic re-renders
    // the editable meanwhile, and that render restores the caret from the
    // still-stale Slate selection, so the suffix lands inside the word. Mod+End
    // moves the caret through the editor's own document API instead.
    await editorPage.keyboard.press('ControlOrMeta+End');
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
