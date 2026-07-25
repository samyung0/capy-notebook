import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';
import { chooseAllBlocksEntry, openAllBlocks } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';

test.describe('shared material modes', () => {
  test('quiz and flashcard materials use view mode actions in the main header', async ({
    ownerPage,
    seed,
  }) => {
    await openWorkspaceMaterial(
      ownerPage,
      seed.privateWorkspace.id,
      seed.privateQuiz.id
    );

    const quizActions = ownerPage.getByRole('toolbar', {
      name: 'Quiz actions',
    });
    await expect(quizActions).toContainText('1 question · Time limit: 15 min');
    await expect(
      quizActions.getByRole('button', { name: 'Start quiz' })
    ).toBeVisible();

    const quizModes = ownerPage.getByRole('combobox');
    await quizModes.click();
    await expect(ownerPage.getByRole('option', { name: 'View' })).toBeVisible();
    await expect(ownerPage.getByRole('option', { name: 'Study' })).toHaveCount(
      0
    );
    await ownerPage.keyboard.press('Escape');

    await openWorkspaceMaterial(
      ownerPage,
      seed.privateWorkspace.id,
      seed.privateDeck.id
    );

    const flashcardActions = ownerPage.getByRole('toolbar', {
      name: 'Flashcard actions',
    });
    await expect(flashcardActions).toContainText('1 card · 0% known');
    await expect(
      flashcardActions.getByRole('button', { name: 'Study' })
    ).toBeVisible();

    const flashcardModes = ownerPage.getByRole('combobox');
    await flashcardModes.click();
    await expect(ownerPage.getByRole('option', { name: 'View' })).toBeVisible();
    await expect(ownerPage.getByRole('option', { name: 'Study' })).toHaveCount(
      0
    );
  });

  test('anonymous visitors always get static view without editor controls', async ({
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
        anonymousPage.getByRole('toolbar', { name: 'Document formatting' })
      ).toHaveCount(0);
      await expect(anonymousPage.getByRole('combobox')).toHaveCount(0);
      await expect(
        anonymousPage.locator('[contenteditable="true"]')
      ).toHaveCount(0);
    }
  });

  test('commenters can suggest with highlighted insertions and deletions', async ({
    materialFactory,
    otherPage,
    seed,
  }) => {
    const body = 'Suggest a clearer sentence';
    const material = await materialFactory.createNote({
      blockId: 'commenter-suggestion-body',
      body,
      title: 'E2E Commenter Suggestion',
      workspaceId: seed.publicWorkspace.id,
    });
    await openWorkspaceMaterial(
      otherPage,
      seed.publicWorkspace.id,
      material.id,
      true
    );
    await expect(otherPage.getByRole('combobox')).toContainText('Suggestion');
    await expect(
      otherPage.getByRole('toolbar', { name: 'Document formatting' })
    ).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: 'Upload image' })
    ).toHaveCount(0);
    await expect(
      otherPage.getByRole('button', { name: /AI commands/ })
    ).toHaveCount(0);

    // Double-click selects one word; typing over it produces a remove+insert
    // suggestion pair in a single transform (no cross-keystroke selection races).
    const editor = otherPage.locator('[contenteditable="true"]').first();
    await editor.getByText(body, { exact: true }).dblclick();
    await otherPage.keyboard.type('replacement');

    const insertion = editor.locator('ins');
    const deletion = editor.locator('del');
    await expect(insertion).toContainText('replacement');
    await expect(insertion).toHaveClass(/bg-tint-accent-2/);
    await expect(deletion).toBeVisible();
    await expect(deletion).toHaveClass(/bg-tint-error/);
    const collaboration = otherPage.getByRole('toolbar', {
      name: 'Material collaboration',
    });
    await expect(
      collaboration.getByRole('button', { name: 'Submit suggestion' })
    ).toBeEnabled();

    const submitted = waitForApi(
      otherPage,
      apiEndsWith(`/api/materials/${material.id}/suggestion-commits`, 'POST')
    );
    await collaboration
      .getByRole('button', { name: 'Submit suggestion' })
      .click();
    expect((await submitted).status()).toBe(201);
    await expect(editor.locator('ins')).toContainText('replacement');

    const modes = otherPage.getByRole('combobox');
    await modes.click();
    await otherPage.getByRole('option', { name: 'View' }).click();
    await expect(otherPage.locator('ins')).toContainText('replacement');
    await expect(otherPage.locator('ins')).toHaveClass(/bg-tint-accent-2/);
    await expect(otherPage.locator('del')).toHaveClass(/bg-tint-error/);
  });

  test('comments render the selected text with the configured highlight', async ({
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
    const editor = otherPage.locator('[contenteditable="true"]').first();
    await editor.getByText(body, { exact: true }).dblclick();
    await chooseAllBlocksEntry(otherPage, 'Comment');
    const commentDialog = otherPage.getByRole('dialog', {
      name: 'Add comment',
    });
    await commentDialog
      .getByRole('textbox', { name: 'Comment' })
      .fill('E2E comment');

    const created = waitForApi(
      otherPage,
      apiEndsWith(`/api/materials/${material.id}/discussions`, 'POST')
    );
    await commentDialog
      .getByRole('button', { exact: true, name: 'Add comment' })
      .click();
    expect((await created).status()).toBe(201);

    const highlight = editor.locator(
      '[class~="bg-tint-accent-2"][class~="underline"]'
    );
    await expect(highlight).toContainText('selected');
    await otherPage
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const popover = otherPage
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(
      popover.getByText('E2E comment', { exact: true })
    ).toBeVisible();
  });

  test('all blocks exposes grouped core insertion commands', async ({
    ownerPage,
    seed,
  }) => {
    await openWorkspaceMaterial(
      ownerPage,
      seed.editableWorkspace.id,
      seed.editableNote.id
    );
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
    await expect(
      menu.getByRole('button', { exact: true, name: 'Heading 4' })
    ).toBeVisible();
    await expect(
      menu.getByRole('button', { exact: true, name: 'Heading 5' })
    ).toBeVisible();
    await expect(
      menu.getByRole('button', { exact: true, name: 'Heading 6' })
    ).toBeVisible();
    await expect(
      menu.getByRole('button', { exact: true, name: 'Bulleted list' })
    ).toBeVisible();
    await expect(
      menu.getByRole('button', { exact: true, name: 'Numbered list' })
    ).toBeVisible();
    await expect(
      menu.getByRole('button', { exact: true, name: 'Task list' })
    ).toBeVisible();
    await expect(
      menu.getByRole('button', { exact: true, name: 'Three equal columns' })
    ).toBeVisible();
  });

  test('shared editors can choose edit, suggestion, and static view without workspace tools', async ({
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
    await expect(
      otherPage.getByRole('toolbar', { name: 'Document formatting' })
    ).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: 'Upload image' })
    ).toHaveCount(0);
    await expect(
      otherPage.getByRole('button', { name: /AI commands/ })
    ).toHaveCount(0);

    await modes.click();
    await expect(otherPage.getByRole('option', { name: 'Edit' })).toBeVisible();
    await expect(
      otherPage.getByRole('option', { name: 'Suggestion' })
    ).toBeVisible();
    await expect(otherPage.getByRole('option', { name: 'View' })).toBeVisible();
    await otherPage.getByRole('option', { name: 'View' }).click();
    await expect(otherPage.getByText(seed.editableNote.body)).toBeVisible();
    await expect(
      otherPage.getByRole('toolbar', { name: 'Document formatting' })
    ).toHaveCount(0);

    await modes.click();
    await otherPage.getByRole('option', { name: 'Suggestion' }).click();
    const collaboration = otherPage.getByRole('toolbar', {
      name: 'Material collaboration',
    });
    await expect(
      collaboration.getByRole('button', { name: 'Submit suggestion' })
    ).toBeDisabled();
  });

  test('viewer, commenter, editor, and owner collaboration permissions follow the role matrix', async ({
    commenterApi,
    editorApi,
    materialFactory,
    ownerApi,
    viewerApi,
    seed,
  }) => {
    const actors = [
      {
        api: viewerApi,
        canComment: false,
        canReview: false,
        canSubmit: false,
        role: 'viewer',
      },
      {
        api: commenterApi,
        canComment: true,
        canReview: false,
        canSubmit: true,
        role: 'commenter',
      },
      {
        api: editorApi,
        canComment: true,
        canReview: true,
        canSubmit: true,
        role: 'editor',
      },
      {
        api: ownerApi,
        canComment: true,
        canReview: true,
        canSubmit: true,
        role: 'owner',
      },
    ] as const;

    for (const actor of actors) {
      const blockId = `role-${actor.role}-block`;
      const material = await materialFactory.createNote({
        blockId,
        body: 'base',
        title: `${actor.role} collaboration matrix`,
        workspaceId: seed.privateWorkspace.id,
      });

      const comment = await actor.api.post(
        `/api/materials/${material.id}/discussions`,
        {
          data: {
            anchor: { blockId },
            blockId,
            contentRich: [
              { children: [{ text: `${actor.role} feedback` }], type: 'p' },
            ],
          },
        }
      );
      expect(comment.status(), `${actor.role} comment permission`).toBe(
        actor.canComment ? 201 : 403
      );

      const plateId = `role-${actor.role}-suggestion`;
      const marked = {
        ...material.content,
        value: [
          {
            children: [
              { text: 'base' },
              {
                suggestion: true,
                text: ` ${actor.role} suggestion`,
                [`suggestion_${actor.role}`]: {
                  id: plateId,
                  type: 'insert',
                  userId: `u_${actor.role}`,
                },
              },
            ],
            id: blockId,
            type: 'p',
          },
        ],
      };
      const submitted = await actor.api.post(
        `/api/materials/${material.id}/suggestion-commits`,
        {
          data: { content: marked, expectedRevision: material.revision },
        }
      );
      expect(submitted.status(), `${actor.role} submit permission`).toBe(
        actor.canSubmit ? 201 : 403
      );

      const reviewed = await actor.api.post(
        `/api/materials/${material.id}/suggestions/review`,
        {
          data: {
            decision: 'accept',
            expectedRevision: actor.canSubmit
              ? material.revision + 1
              : material.revision,
            suggestionIds: actor.canSubmit ? [plateId] : undefined,
          },
        }
      );
      expect(reviewed.status(), `${actor.role} review permission`).toBe(
        actor.canReview ? 200 : 403
      );
    }
  });

  test('accepting a suggestion updates content and status atomically', async ({
    materialFactory,
    ownerPage,
    otherApi,
    ownerApi,
    seed,
  }) => {
    const originalBody = 'Original review sentence';
    const material = await materialFactory.createNote({
      blockId: 'suggestion-review-body',
      body: originalBody,
      title: 'E2E Suggestion Review',
      workspaceId: seed.editableWorkspace.id,
    });
    const proposed = structuredClone(material.content.value);
    proposed![0].children = [
      {
        suggestion: true,
        suggestion_replace: {
          id: 'replace-e2e',
          type: 'remove',
          userId: 'u_other',
        },
        text: originalBody,
      },
      {
        suggestion: true,
        suggestion_replace: {
          id: 'replace-e2e',
          type: 'insert',
          userId: 'u_other',
        },
        text: 'Accepted review sentence',
      },
    ];
    const create = await otherApi.post(
      `/api/materials/${material.id}/suggestion-commits`,
      {
        data: {
          content: { ...material.content, value: proposed },
          expectedRevision: material.revision,
        },
      }
    );
    expect(create.status()).toBe(201);
    const mutation = await create.json();
    const suggestion = mutation.discussions
      .flatMap(
        (discussion: { suggestions: Array<{ plateSuggestionId: string }> }) =>
          discussion.suggestions
      )
      .find(
        (entry: { plateSuggestionId: string }) =>
          entry.plateSuggestionId === 'replace-e2e'
      );
    expect(suggestion).toBeTruthy();

    await openWorkspaceMaterial(
      ownerPage,
      seed.editableWorkspace.id,
      material.id
    );
    await ownerPage
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const popover = ownerPage
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(popover.getByText('Accepted review sentence')).toBeVisible();
    const accepted = waitForApi(
      ownerPage,
      apiEndsWith(`/api/materials/${material.id}/suggestions/review`, 'POST')
    );
    await popover.getByRole('button', { name: 'Accept' }).click();
    expect((await accepted).status()).toBe(200);

    const updatedMaterial = await ownerApi.get(`/api/materials/${material.id}`);
    const updated = await updatedMaterial.json();
    expect(updated.revision).toBe(material.revision + 2);
    expect(JSON.stringify(updated.content)).toContain(
      'Accepted review sentence'
    );
    expect(JSON.stringify(updated.content)).not.toContain(originalBody);

    const discussions = await ownerApi.get(
      `/api/materials/${material.id}/discussions`
    );
    const reviewed = (await discussions.json())
      .flatMap(
        (discussion: { suggestions: Array<{ plateSuggestionId: string }> }) =>
          discussion.suggestions
      )
      .find(
        (item: { plateSuggestionId: string }) =>
          item.plateSuggestionId === 'replace-e2e'
      );
    expect(reviewed.status).toBe('accepted');
  });
});
