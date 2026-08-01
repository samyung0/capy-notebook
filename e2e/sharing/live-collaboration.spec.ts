import { expect, test } from '../fixtures/actors';
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
    await expect(ownerPage.getByText('Synced', { exact: true })).toBeVisible();
    await expect(editorPage.getByText('Synced', { exact: true })).toBeVisible();

    const editor = editorPage.locator('[contenteditable="true"]').first();
    await editor.getByText(body, { exact: true }).dblclick();
    await expect(
      ownerPage.locator('[data-remote-cursor="E2E Editor"]')
    ).toBeVisible();

    await editor.getByText(body, { exact: true }).click();
    await editorPage.keyboard.press('End');
    await editorPage.keyboard.type(suffix);
    await expect(
      ownerPage.getByText(`${body}${suffix}`, { exact: true })
    ).toBeVisible();
    await expect(editorPage.getByText('Saved', { exact: true })).toBeVisible();

    // Projection completion invalidates the material query before static mode.
    await expect
      .poll(async () => {
        const response = await ownerApi.get(`/api/materials/${material.id}`);
        return response.ok() ? await response.text() : '';
      })
      .toContain(`${body}${suffix}`);

    const modes = ownerPage.getByRole('combobox');
    await modes.click();
    await ownerPage.getByRole('option', { name: 'View' }).click();
    await expect(
      ownerPage.getByText(`${body}${suffix}`, { exact: true })
    ).toBeVisible();
    await expect(ownerPage.locator('[contenteditable="true"]')).toHaveCount(0);
  });
});
