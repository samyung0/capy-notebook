import type { Page } from '@playwright/test';
import type { Material, SourceFile } from '../../src/api/types';
import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';
import { m } from '../i18n';

// The clone dialog for one file or material. Who may clone and what a copy
// carries are asserted in Go: server/internal/store/item_clone_test.go.

/** A row's ⋮ menu in the workspace Files panel. */
async function openRowMenu(page: Page, name: string) {
  const row = page
    .locator('[data-workspace-file-tree]')
    .getByRole('link', { name })
    .locator('xpath=..');
  await row.hover();
  await row.getByRole('button', { name: m.a11y_open_menu() }).click();
}

test('a file clones into another workspace under a new name', async ({
  ownerApi,
  ownerPage,
  seed,
  workspaceFactory,
}) => {
  const target = await workspaceFactory.create({
    name: `Clone target ${Date.now()}`,
  });
  const workspaceId = seed.privateWorkspace.id;
  const files = (await (
    await ownerApi.get(`/api/workspaces/${workspaceId}/files`)
  ).json()) as SourceFile[];
  const file = files.find((f) => f.name === seed.privateWorkspace.secretFile);
  if (!file) throw new Error('Seed file is missing');

  await ownerPage.goto(`/workspaces/${workspaceId}`);
  await openRowMenu(ownerPage, file.name);
  await ownerPage
    .getByRole('menuitem', { exact: true, name: m.action_clone() })
    .click();
  const dialog = ownerPage.getByRole('dialog', { name: m.action_clone_file() });
  const name = dialog.getByRole('textbox');
  // Next to its source, the copy's name says it is a copy.
  await expect(name).toHaveValue('secret-notes (copy).md');
  await dialog
    .getByRole('combobox', { name: m.question_ui_workspace() })
    .click();
  await ownerPage.getByRole('option', { name: target.name }).click();
  await expect(name).toHaveValue(file.name);
  await name.fill('copied-notes.md');

  const cloned = waitForApi(
    ownerPage,
    apiEndsWith(`/api/files/${file.id}/clone`, 'POST')
  );
  await dialog
    .getByRole('button', { exact: true, name: m.action_clone() })
    .click();
  const response = await cloned;
  expect(response.status()).toBe(201);
  const copy = (await response.json()) as SourceFile;
  expect(copy.workspaceId).toBe(target.id);
  expect(copy.name).toBe('copied-notes.md');
  await expect(ownerPage).toHaveURL(`/workspaces/${target.id}?file=${copy.id}`);
});

test('a read-only member clones a note to No workspace from its row menu', async ({
  materialFactory,
  seed,
  viewerApi,
  viewerPage,
}) => {
  const workspaceId = seed.privateWorkspace.id;
  const note = await materialFactory.createNote({
    blockId: 'clone-body',
    body: 'Copy me',
    title: 'Clone source',
    workspaceId,
  });

  await viewerPage.goto(`/workspaces/${workspaceId}`);
  await openRowMenu(viewerPage, note.title);
  // A viewer's menu offers Clone only.
  await expect(viewerPage.getByRole('menuitem')).toHaveCount(1);
  await viewerPage
    .getByRole('menuitem', { exact: true, name: m.action_clone() })
    .click();
  const dialog = viewerPage.getByRole('dialog', {
    name: m.action_clone_note(),
  });
  await dialog
    .getByRole('combobox', { name: m.question_ui_workspace() })
    .click();
  await viewerPage
    .getByRole('option', { name: m.clone_no_workspace() })
    .click();
  await expect(dialog.getByRole('textbox')).toHaveValue(note.title);

  const cloned = waitForApi(
    viewerPage,
    apiEndsWith(`/api/materials/${note.id}/clone`, 'POST')
  );
  await dialog
    .getByRole('button', { exact: true, name: m.action_clone() })
    .click();
  const response = await cloned;
  expect(response.status()).toBe(201);
  const copy = (await response.json()) as Material;
  try {
    expect(copy.workspaceId).toBe('');
    expect(copy.title).toBe(note.title);
    await expect(viewerPage).toHaveURL(`/materials/${copy.id}`);
  } finally {
    expect((await viewerApi.delete(`/api/materials/${copy.id}`)).status()).toBe(
      204
    );
  }
});
