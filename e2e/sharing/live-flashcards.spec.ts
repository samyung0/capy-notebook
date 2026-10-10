import { randomUUID } from 'node:crypto';
import { expect, test } from '../fixtures/actors';
import { openWorkspaceMaterial } from '../helpers/workspace';
import { m } from '../i18n';

// Flashcard sets edit live (Epo 2026-10-10): two editors' changes merge as
// they type, with no Save, and a signed-in viewer's View follows them on a
// read channel.
test('editors edit a set together and a viewer reads it as it changes', async ({
  editorPage,
  ownerApi,
  ownerPage,
  seed,
  viewerPage,
}) => {
  const workspaceId = seed.privateWorkspace.id;
  const created = await ownerApi.post('/api/flashcards', {
    data: { name: `E2E Live Set ${randomUUID()}`, workspaceId },
  });
  expect(created.status()).toBe(201);
  const setId = ((await created.json()) as { id: string }).id;

  await Promise.all([
    openWorkspaceMaterial(ownerPage, workspaceId, setId),
    openWorkspaceMaterial(editorPage, workspaceId, setId, true),
    viewerPage.goto(
      `/workspaces/${workspaceId}?material=${encodeURIComponent(setId)}`
    ),
  ]);

  await ownerPage
    .getByRole('button', { exact: true, name: m.flashcards_add_card() })
    .click();
  const ownerDialog = ownerPage.getByRole('dialog', {
    name: m.flashcards_edit_card(),
  });
  await ownerDialog
    .getByRole('textbox', { name: m.editor_card_front() })
    .fill('Osmosis');
  await ownerDialog
    .getByRole('textbox', { name: m.editor_card_back() })
    .fill('Water crosses a membrane');

  // The other editor sees the card as it is typed, and adds to its back
  // while the owner's dialog stays open on it.
  await editorPage.getByText('Osmosis', { exact: true }).click();
  const editorDialog = editorPage.getByRole('dialog', {
    name: m.flashcards_edit_card(),
  });
  const editorBack = editorDialog.getByRole('textbox', {
    name: m.editor_card_back(),
  });
  await expect(editorBack).toHaveValue('Water crosses a membrane');
  await editorBack.press('End');
  await editorBack.pressSequentially(' by diffusion');
  await expect(
    ownerDialog.getByRole('textbox', { name: m.editor_card_back() })
  ).toHaveValue('Water crosses a membrane by diffusion');

  // The viewer reads the set live and has nothing to edit with.
  await expect(viewerPage.getByText('Osmosis', { exact: true })).toBeVisible();
  await expect(
    viewerPage.getByRole('button', {
      exact: true,
      name: m.flashcards_add_card(),
    })
  ).toHaveCount(0);

  // The set projects once idle: its cards read as edited.
  await ownerPage.keyboard.press('Escape');
  await editorPage.keyboard.press('Escape');
  await expect
    .poll(
      async () => {
        const response = await ownerApi.get(`/api/flashcards/${setId}/cards`);
        return response.ok() ? await response.text() : '';
      },
      { timeout: 60_000 }
    )
    .toContain('Water crosses a membrane by diffusion');
  await ownerApi.delete(`/api/materials/${setId}`);
});
