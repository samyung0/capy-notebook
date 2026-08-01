import { expect, test } from '../fixtures/actors';
import { openAllBlocks } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';

test.describe('shared material modes', () => {
  test('quiz and flashcard materials use view actions', async ({
    ownerPage,
    seed,
  }) => {
    await openWorkspaceMaterial(
      ownerPage,
      seed.privateWorkspace.id,
      seed.privateQuiz.id
    );
    await expect(
      ownerPage.getByRole('toolbar', { name: 'Quiz actions' })
    ).toContainText('1 question · Time limit: 15 min');

    await openWorkspaceMaterial(
      ownerPage,
      seed.privateWorkspace.id,
      seed.privateDeck.id
    );
    await expect(
      ownerPage.getByRole('toolbar', { name: 'Flashcard actions' })
    ).toContainText('1 card · 0% known');
  });

  test('anonymous viewers stay static and never join the editor', async ({
    anonymousPage,
    seed,
  }) => {
    for (const [workspaceId, material] of [
      [seed.linkWorkspace.id, seed.viewerNote],
      [seed.editableWorkspace.id, seed.editableNote],
    ] as const) {
      await openWorkspaceMaterial(
        anonymousPage,
        workspaceId,
        material.id,
        true
      );
      await expect(anonymousPage.getByText(material.body)).toBeVisible();
      await expect(
        anonymousPage.locator('[contenteditable="true"]')
      ).toHaveCount(0);
      await expect(anonymousPage.getByRole('combobox')).toHaveCount(0);
    }
  });

  test('commenters get live read-only Plate and can add comments', async ({
    materialFactory,
    otherPage,
    seed,
  }) => {
    const body = 'Comment on this selected sentence';
    const material = await materialFactory.createNote({
      blockId: 'comment-highlight-body',
      body,
      title: 'E2E Comment Highlight',
      workspaceId: seed.publicWorkspace.id,
    });
    await openWorkspaceMaterial(
      otherPage,
      seed.publicWorkspace.id,
      material.id,
      true
    );
    await expect(otherPage.getByRole('combobox')).toContainText('Comment');
    await expect(otherPage.getByText('Synced', { exact: true })).toBeVisible();
    await expect(
      otherPage.getByRole('toolbar', { name: 'Document formatting' })
    ).toHaveCount(0);
    await expect(otherPage.locator('[contenteditable="true"]')).toHaveCount(0);

    const editor = otherPage.locator('[data-slate-editor="true"]').first();
    await editor.getByText(body, { exact: true }).dblclick();
    await otherPage
      .getByRole('toolbar', { name: 'Material collaboration' })
      .getByRole('button', { exact: true, name: 'Comment' })
      .click();
    const dialog = otherPage.getByRole('dialog', { name: 'Add comment' });
    await dialog
      .getByRole('textbox', { name: 'Comment' })
      .fill('E2E relative comment');
    await dialog
      .getByRole('button', { exact: true, name: 'Add comment' })
      .click();

    await expect(
      editor.locator('[class~="bg-tint-accent-2"][class~="underline"]')
    ).toContainText('selected');
    await otherPage
      .getByRole('button', { name: 'Show 1 comment thread' })
      .click();
    await expect(
      otherPage.getByText('E2E relative comment', { exact: true })
    ).toBeVisible();
  });

  test('editors can choose edit, comment, and view', async ({
    otherPage,
    seed,
  }) => {
    await openWorkspaceMaterial(
      otherPage,
      seed.editableWorkspace.id,
      seed.editableNote.id,
      true
    );
    const modes = otherPage.getByRole('combobox');
    await expect(modes).toContainText('Edit');
    await modes.click();
    await expect(otherPage.getByRole('option', { name: 'Edit' })).toBeVisible();
    await expect(
      otherPage.getByRole('option', { name: 'Comment' })
    ).toBeVisible();
    await expect(otherPage.getByRole('option', { name: 'View' })).toBeVisible();
  });

  test('mod+k and all-block menus expose editor commands', async ({
    ownerPage,
    seed,
  }) => {
    await openWorkspaceMaterial(
      ownerPage,
      seed.editableWorkspace.id,
      seed.editableNote.id
    );
    await expect(ownerPage.getByText('Synced', { exact: true })).toBeVisible();
    await ownerPage.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          key: 'k',
          metaKey: true,
        })
      );
    });
    await expect(
      ownerPage.getByRole('dialog', { name: 'Editor command palette' })
    ).toBeVisible();
    await ownerPage.keyboard.press('Escape');

    const menu = await openAllBlocks(ownerPage);
    for (const heading of [
      'Basic blocks',
      'Lists',
      'Media',
      'Advanced blocks',
      'Inline',
    ]) {
      await expect(
        menu.getByRole('heading', { exact: true, name: heading })
      ).toBeVisible();
    }
  });

  test('room tokens and comment APIs follow the role matrix', async ({
    commenterApi,
    editorApi,
    materialFactory,
    ownerApi,
    viewerApi,
    seed,
  }) => {
    const material = await materialFactory.createNote({
      blockId: 'role-matrix-block',
      body: 'base',
      title: 'Collaboration role matrix',
      workspaceId: seed.privateWorkspace.id,
    });
    const actors = [
      { access: null, api: viewerApi, canComment: false },
      { access: 'comment', api: commenterApi, canComment: true },
      { access: 'write', api: editorApi, canComment: true },
      { access: 'write', api: ownerApi, canComment: true },
    ] as const;

    for (const actor of actors) {
      const token = await actor.api.post(
        `/api/materials/${material.id}/collaboration-token`
      );
      if (actor.access) {
        expect(token.status()).toBe(201);
        expect(await token.json()).toMatchObject({ access: actor.access });
      } else {
        expect(token.status()).toBe(403);
      }

      const comment = await actor.api.post(
        `/api/materials/${material.id}/discussions`,
        {
          data: {
            anchorQuote: '',
            anchorVersion: 1,
            blockId: 'role-matrix-block',
            contentRich: [{ children: [{ text: 'feedback' }], type: 'p' }],
          },
        }
      );
      expect(comment.status()).toBe(actor.canComment ? 201 : 403);
    }
  });
});
