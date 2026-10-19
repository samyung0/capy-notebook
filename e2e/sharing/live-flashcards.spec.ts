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

// REVIEW3 N6 through StudyBody (REVIEW4 S3): an editor blanking the card a
// learner is studying while retyping it leaves that card where it is, blank,
// then retyped; it neither leaves the session nor comes back at its end.
test('a card blanked while retyped keeps its place in a study session', async ({
  editorPage,
  ownerApi,
  ownerPage,
  seed,
}) => {
  const workspaceId = seed.privateWorkspace.id;
  const faces = [
    ['Osmosis', 'Water crosses a membrane'],
    ['Golgi', 'Packages proteins'],
    ['Ribosome', 'Builds proteins'],
  ];
  const created = await ownerApi.post(
    `/api/workspaces/${workspaceId}/materials`,
    {
      data: {
        content: {
          schemaVersion: 1,
          value: [
            {
              children: faces.map(([front, back]) => ({
                children: [
                  { children: [{ text: front }], type: 'flashcard_front' },
                  { children: [{ text: back }], type: 'flashcard_back' },
                ],
                id: `c_e2e_${randomUUID()}`,
                type: 'flashcard',
              })),
              id: 'cards_root',
              type: 'flashcards',
            },
          ],
        },
        kind: 'flashcards',
        title: `E2E Blank Card ${randomUUID()}`,
      },
    }
  );
  expect(created.status()).toBe(201);
  const setId = ((await created.json()) as { id: string }).id;
  try {
    await openWorkspaceMaterial(ownerPage, workspaceId, setId);
    await editorPage.goto(`/flashcards/${setId}`);
    const first = m.flashcards_card_of_total({ position: 1, total: 3 });
    await expect(editorPage.getByText(first)).toBeVisible();
    await expect(
      editorPage.getByText('Osmosis', { exact: true })
    ).toBeVisible();

    await ownerPage.getByText('Osmosis', { exact: true }).click();
    const dialog = ownerPage.getByRole('dialog', {
      name: m.flashcards_edit_card(),
    });
    await dialog.getByRole('textbox', { name: m.editor_card_front() }).fill('');
    await dialog.getByRole('textbox', { name: m.editor_card_back() }).fill('');
    // The learner still studies that card, now blank.
    await expect(editorPage.getByText('Osmosis', { exact: true })).toHaveCount(
      0
    );
    await expect(editorPage.getByText('Golgi', { exact: true })).toHaveCount(0);
    await expect(editorPage.getByText(first)).toBeVisible();
    await dialog
      .getByRole('textbox', { name: m.editor_card_front() })
      .fill('Osmosis, retyped');
    await dialog
      .getByRole('textbox', { name: m.editor_card_back() })
      .fill('Water crosses again');
    await expect(
      editorPage.getByText('Osmosis, retyped', { exact: true })
    ).toBeVisible();
    await expect(editorPage.getByText(first)).toBeVisible();

    // Three ratings end the session: the card did not come back at its end.
    const showAnswer = editorPage.getByRole('button', {
      name: m.flashcards_show_answer(),
    });
    for (let i = 0; i < 3; i++) {
      await showAnswer.click();
      await editorPage
        .getByRole('button', { exact: true, name: m.srs_good() })
        .click();
    }
    await expect(
      editorPage.getByRole('button', { name: m.flashcards_study_again() })
    ).toBeVisible();
  } finally {
    await ownerApi.delete(`/api/materials/${setId}`);
  }
});
