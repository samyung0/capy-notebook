import { expect, test } from '@playwright/test';
import { EDITOR_NOTE, SUGGEST_NOTE } from '../../src/mocks/editorSeed';
import { chooseAllBlocksEntry } from '../helpers/editor';
import { editorApi, openEditorNote } from './helpers';

type TestMaterialDocument = {
  schemaVersion: number;
  value: Array<{
    children: Array<Record<string, unknown>>;
    id?: string;
    [key: string]: unknown;
  }>;
};

type TestMaterialResponse = {
  content: TestMaterialDocument;
  revision: number;
};

type TestSuggestionMutation = {
  discussions: Array<{
    id: string;
    suggestions: Array<{ plateSuggestionId: string }>;
  }>;
  revision: number;
};

const commentValue = (text: string) => [{ children: [{ text }], type: 'p' }];

function withInsertionSuggestion(
  document: TestMaterialDocument,
  blockIndex: number,
  suggestionId: string,
  text: string
): TestMaterialDocument {
  const marked = structuredClone(document);
  const block = marked.value[blockIndex];
  if (!block?.id) {
    throw new Error('Suggestion fixtures require a stable block ID');
  }
  block.children.push({
    suggestion: true,
    [`suggestion_${suggestionId}`]: {
      id: suggestionId,
      type: 'insert',
      userId: 'u_1',
    },
    text,
  });
  return marked;
}

function containsRuntimeCommentMetadata(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRuntimeCommentMetadata);
  if (!(value && typeof value === 'object')) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).some(
      (key) => key === 'comment' || key.startsWith('comment_')
    ) || Object.values(record).some(containsRuntimeCommentMetadata)
  );
}

test.describe('suggestion mode', () => {
  test('typing marks an insertion without a phantom trailing-line suggestion', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      SUGGEST_NOTE.id,
      SUGGEST_NOTE.body
    );
    await expect(page.getByRole('combobox')).toContainText('Suggestion');

    await editor.getByText(SUGGEST_NOTE.body, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' plus addition');

    const insertion = editor.locator('ins');
    await expect(insertion).toHaveCount(1);
    await expect(insertion).toContainText('plus addition');

    // Regression: TrailingBlockPlugin's housekeeping insert used to register
    // as a block suggestion, showing a permanent "appended line" at the end.
    await expect(editor.locator('[data-block-suggestion]')).toHaveCount(0);
    await expect(editor.locator('svg.lucide-corner-down-left')).toHaveCount(0);
    // A local draft keeps its suggestion card, but is attributed to the
    // signed-in user instead of being misclassified as a persisted orphan.
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const draftCard = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(
      draftCard.getByText('Suggestion from Kate Malone')
    ).toBeVisible();
    await expect(draftCard.getByText('draft', { exact: true })).toBeVisible();
    await expect(draftCard.getByText(/missing lifecycle/)).toHaveCount(0);
    await expect(draftCard.getByText('plus addition')).toBeVisible();
  });

  test('submitting and reloading preserves only the marked replacement range', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      SUGGEST_NOTE.id,
      SUGGEST_NOTE.body
    );

    // Double-click selects one word; typing over it produces a remove+insert
    // suggestion pair in a single transform.
    await editor.getByText(SUGGEST_NOTE.body, { exact: true }).dblclick();
    await page.keyboard.type('replacement');
    await expect(editor.locator('ins')).toContainText('replacement');
    await expect(editor.locator('del')).toBeVisible();

    const collaboration = page.getByRole('toolbar', {
      name: 'Material collaboration',
    });
    await collaboration
      .getByRole('button', { name: 'Submit suggestion' })
      .click();

    // The persisted revision head remains visibly marked, but only the edited
    // range is suggested (not a delete/reinsert of the whole document).
    await expect(editor.locator('ins')).toHaveCount(1);
    await expect(editor.locator('del')).toHaveCount(1);
    await expect(editor.locator('ins')).not.toContainText(
      SUGGEST_NOTE.headingText
    );
    await expect(editor.locator('del')).not.toContainText(
      SUGGEST_NOTE.headingText
    );
    // Suggestion discussions carry block anchors, not Slate comment ranges.
    // They must never decorate the submitted document as comments.
    await expect(
      editor.locator('[data-collaboration-mark="comment"]')
    ).toHaveCount(0);

    // Clicking marked content opens and focuses the owning block popover.
    await editor.locator('ins').click();
    const card = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Suggestion from Kate Malone')).toBeVisible();
    // The card lists the discrete before/after values, not the whole file.
    await expect(card.getByText('suggestion', { exact: true })).toBeVisible();
    await expect(card.getByText('replacement')).toBeVisible();
    // Regression: the whole document used to appear as deleted + re-added.
    await expect(card.getByText(SUGGEST_NOTE.headingText)).toHaveCount(0);

    // Submitted pending changes survive a full reload in suggestion mode.
    await page.keyboard.press('Escape');
    await page.reload();
    const reloaded = page.locator('[contenteditable="true"]').first();
    await expect(reloaded).toBeVisible({ timeout: 30_000 });
    await expect(reloaded.locator('ins')).toContainText('replacement', {
      timeout: 30_000,
    });
    await expect(reloaded.locator('del')).toBeVisible();
    await reloaded.locator('ins').click();
    const reloadedCard = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(reloadedCard.getByText('replacement')).toBeVisible();

    // The same marked revision head also renders in static View mode.
    await page.keyboard.press('Escape');
    const modes = page.getByRole('combobox');
    await modes.click();
    await page.getByRole('option', { name: 'View' }).click();
    await expect(page.locator('ins')).toContainText('replacement');
  });

  test('an editor sees submitted changes after returning to edit mode', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const modes = page.getByRole('combobox');
    await modes.click();
    await page.getByRole('option', { name: 'Suggestion' }).click();

    const editor = page.locator('[contenteditable="true"]').first();
    await editor
      .getByText(EDITOR_NOTE.firstParagraph, { exact: true })
      .dblclick();
    await page.keyboard.type('owner replacement');
    await page
      .getByRole('toolbar', { name: 'Material collaboration' })
      .getByRole('button', { name: 'Submit suggestion' })
      .click();
    await expect(page.locator('ins')).toContainText('owner replacement');

    await modes.click();
    await page.getByRole('option', { name: 'Edit' }).click();
    await expect(page.locator('ins')).toContainText('owner replacement');
  });

  test('submitting a new line records it and anchors it to a surviving block', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      SUGGEST_NOTE.id,
      SUGGEST_NOTE.body
    );

    await editor.getByText(SUGGEST_NOTE.body, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(editor.locator('svg.lucide-corner-down-left')).toBeVisible();

    const collaboration = page.getByRole('toolbar', {
      name: 'Material collaboration',
    });
    await collaboration
      .getByRole('button', { name: 'Submit suggestion' })
      .click();

    // The inserted empty block is removed by the reset, but its line-break
    // suggestion remains attached to the preceding base block.
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const card = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(card).toContainText('(line break)');
  });

  test('clicking a normal comment mark opens its thread before and after reload', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      SUGGEST_NOTE.id,
      SUGGEST_NOTE.body
    );

    await editor.getByText(SUGGEST_NOTE.body, { exact: true }).dblclick();
    await chooseAllBlocksEntry(page, 'Comment');
    const commentDialog = page.getByRole('dialog', { name: 'Add comment' });
    await commentDialog
      .getByRole('textbox', { name: 'Comment' })
      .fill('E2E matrix comment');
    await commentDialog
      .getByRole('button', { exact: true, name: 'Add comment' })
      .click();

    // The selection is marked with the comment highlight…
    await expect(
      editor.locator('[data-collaboration-mark="comment"]').first()
    ).toBeVisible();
    // …and clicking the mark opens the owning block's collaboration popover.
    await editor.locator('[data-collaboration-mark="comment"]').first().click();
    await expect(
      page.getByText('E2E matrix comment', { exact: true })
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await page.reload();
    const reloaded = page.locator('[contenteditable="true"]').first();
    const reloadedMark = reloaded
      .locator('[data-collaboration-mark="comment"]')
      .first();
    await expect(reloadedMark).toBeVisible();
    await reloadedMark.click();
    await expect(
      page.getByText('E2E matrix comment', { exact: true })
    ).toBeVisible();
  });

  test('Plate metadata remains authoritative when lifecycle preview data is stale', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      SUGGEST_NOTE.id,
      SUGGEST_NOTE.body
    );
    const material = await editorApi<TestMaterialResponse>(
      page,
      `/api/materials/${SUGGEST_NOTE.id}`
    );
    const suggestionId = 'plate-authority';
    const initiallyMarked = withInsertionSuggestion(
      material.body.content,
      1,
      suggestionId,
      ' stale lifecycle preview'
    );
    const committed = await editorApi<TestSuggestionMutation>(
      page,
      `/api/materials/${SUGGEST_NOTE.id}/suggestion-commits`,
      {
        body: {
          content: initiallyMarked,
          expectedRevision: material.body.revision,
        },
        method: 'POST',
      }
    );
    expect(committed.status).toBe(201);

    // Keep the lifecycle row and Plate ID, but change the marked revision head.
    // The card must scan the document instead of trusting denormalized previews.
    const authoritative = structuredClone(initiallyMarked);
    const markedLeaf = authoritative.value[1]?.children.at(-1);
    if (!markedLeaf) throw new Error('Marked suggestion leaf is missing');
    markedLeaf.text = ' authoritative Plate preview';
    const patched = await editorApi(page, `/api/materials/${EDITOR_NOTE.id}`, {
      body: {
        content: authoritative,
        expectedRevision: committed.body.revision,
      },
      method: 'PATCH',
    });
    expect(patched.status).toBe(200);

    await page.reload();
    const mark = editor
      .locator('ins')
      .filter({ hasText: 'authoritative Plate preview' });
    await expect(mark).toBeVisible();
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const card = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(
      card.getByText('authoritative Plate preview', { exact: true })
    ).toBeVisible();
    await expect(card.getByText('stale lifecycle preview')).toHaveCount(0);
  });

  test('suggestion comments and replies render inside the suggestion card', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      EDITOR_NOTE.id,
      EDITOR_NOTE.firstParagraph
    );
    const material = await editorApi<TestMaterialResponse>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`
    );
    const suggestionId = 'threaded-suggestion';
    const content = withInsertionSuggestion(
      material.body.content,
      1,
      suggestionId,
      ' threaded suggestion'
    );
    const committed = await editorApi<TestSuggestionMutation>(
      page,
      `/api/materials/${EDITOR_NOTE.id}/suggestion-commits`,
      {
        body: { content, expectedRevision: material.body.revision },
        method: 'POST',
      }
    );
    expect(committed.status).toBe(201);
    const discussion = committed.body.discussions.find((entry) =>
      entry.suggestions.some(
        (suggestion) => suggestion.plateSuggestionId === suggestionId
      )
    );
    if (!discussion) throw new Error('Suggestion discussion was not created');

    const root = await editorApi<{ id: string }>(
      page,
      `/api/discussions/${discussion.id}/comments`,
      {
        body: { contentRich: commentValue('Suggestion root feedback') },
        method: 'POST',
      }
    );
    expect(root.status).toBe(201);
    const reply = await editorApi(
      page,
      `/api/discussions/${discussion.id}/comments`,
      {
        body: {
          contentRich: commentValue('Suggestion feedback reply'),
          parentCommentId: root.body.id,
        },
        method: 'POST',
      }
    );
    expect(reply.status).toBe(201);

    await page.reload();
    const suggestionMark = editor
      .locator('ins')
      .filter({ hasText: 'threaded suggestion' });
    await expect(suggestionMark).toBeVisible();
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const popover = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    const suggestionCard = popover
      .locator('section')
      .filter({ hasText: 'threaded suggestion' })
      .filter({ hasText: 'Suggestion root feedback' });
    await expect(suggestionCard).toContainText('Suggestion feedback reply');
  });

  test('a user can reply to a suggestion comment from its card', async ({
    page,
  }) => {
    const editor = await openEditorNote(
      page,
      SUGGEST_NOTE.id,
      SUGGEST_NOTE.body
    );
    const material = await editorApi<TestMaterialResponse>(
      page,
      `/api/materials/${SUGGEST_NOTE.id}`
    );
    const suggestionId = 'ui-reply-suggestion';
    const content = withInsertionSuggestion(
      material.body.content,
      1,
      suggestionId,
      ' UI reply suggestion'
    );
    const committed = await editorApi<TestSuggestionMutation>(
      page,
      `/api/materials/${SUGGEST_NOTE.id}/suggestion-commits`,
      {
        body: { content, expectedRevision: material.body.revision },
        method: 'POST',
      }
    );
    expect(committed.status).toBe(201);
    const discussion = committed.body.discussions.find((entry) =>
      entry.suggestions.some(
        (suggestion) => suggestion.plateSuggestionId === suggestionId
      )
    );
    if (!discussion) throw new Error('Suggestion discussion was not created');

    const root = await editorApi<{ id: string }>(
      page,
      `/api/discussions/${discussion.id}/comments`,
      {
        body: { contentRich: commentValue('Suggestion root for UI reply') },
        method: 'POST',
      }
    );
    expect(root.status).toBe(201);

    await page.reload();
    await expect(editor.locator('ins')).toContainText('UI reply suggestion');
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const popover = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    const suggestionCard = popover
      .locator('section')
      .filter({ hasText: 'UI reply suggestion' })
      .filter({ hasText: 'Suggestion root for UI reply' });

    await suggestionCard
      .getByRole('button', { exact: true, name: 'Reply' })
      .click();
    await popover
      .getByRole('textbox', { name: 'Reply' })
      .fill('Reply sent from suggestion card');
    await suggestionCard
      .getByRole('button', { exact: true, name: 'Reply' })
      .last()
      .click();

    await expect(
      suggestionCard.getByText('Reply sent from suggestion card', {
        exact: true,
      })
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await page.reload();
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    await expect(
      page
        .getByRole('dialog')
        .filter({ hasText: 'Comments & suggestions' })
        .getByText('Reply sent from suggestion card', { exact: true })
    ).toBeVisible();
  });

  test('marked commits require stable block IDs and the current revision', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const material = await editorApi<TestMaterialResponse>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`
    );
    const withoutStableId = withInsertionSuggestion(
      material.body.content,
      1,
      'missing-stable-id',
      ' invalid anchor'
    );
    const invalidBlock = withoutStableId.value[1];
    if (!invalidBlock) throw new Error('Suggestion block fixture is missing');
    delete invalidBlock.id;
    const invalid = await editorApi(
      page,
      `/api/materials/${EDITOR_NOTE.id}/suggestion-commits`,
      {
        body: {
          content: withoutStableId,
          expectedRevision: material.body.revision,
        },
        method: 'POST',
      }
    );
    expect(invalid.status).toBe(400);

    const bumped = await editorApi<{ revision: number }>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`,
      {
        body: {
          content: material.body.content,
          expectedRevision: material.body.revision,
        },
        method: 'PATCH',
      }
    );
    expect(bumped.status).toBe(200);
    const staleMarked = withInsertionSuggestion(
      material.body.content,
      1,
      'stale-full-commit',
      ' stale full document'
    );
    const stale = await editorApi(
      page,
      `/api/materials/${EDITOR_NOTE.id}/suggestion-commits`,
      {
        body: {
          content: staleMarked,
          expectedRevision: material.body.revision,
        },
        method: 'POST',
      }
    );
    expect(stale.status).toBe(409);
    const persisted = await editorApi<TestMaterialResponse>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`
    );
    expect(persisted.body.revision).toBe(bumped.body.revision);
    expect(JSON.stringify(persisted.body.content)).not.toContain(
      'stale-full-commit'
    );
  });

  test('runtime comment marks are excluded from a later edit save', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const created = await editorApi(
      page,
      `/api/materials/${EDITOR_NOTE.id}/discussions`,
      {
        body: {
          anchor: {
            anchor: { offset: 0, path: [1, 0] },
            focus: { offset: 5, path: [1, 0] },
          },
          blockId: `${EDITOR_NOTE.id}:first`,
          contentRich: commentValue('Runtime-only comment mark'),
        },
        method: 'POST',
      }
    );
    expect(created.status).toBe(201);

    await page.reload();
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(
      editor.locator('[data-collaboration-mark="comment"]').first()
    ).toBeVisible();
    await editor
      .getByText(EDITOR_NOTE.secondParagraph, { exact: true })
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type(' saved without runtime marks');

    const saveStatus = page.getByRole('status');
    await expect(saveStatus).toHaveText('Unsaved');
    await expect(saveStatus).toHaveText('Saved', { timeout: 15_000 });
    const persisted = await editorApi<TestMaterialResponse>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`
    );
    expect(containsRuntimeCommentMetadata(persisted.body.content)).toBe(false);
    expect(JSON.stringify(persisted.body.content)).toContain(
      'saved without runtime marks'
    );
  });

  test('an editor reviews one submitted change then bulk-rejects the remainder', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const materialResponse = await editorApi<any>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`
    );
    expect(materialResponse.status).toBe(200);
    const content = structuredClone(materialResponse.body.content);
    content.value[1].children.push({
      suggestion: true,
      suggestion_first_review: {
        id: 'first-review',
        type: 'insert',
        userId: 'u_commenter',
      },
      text: ' first pending addition',
    });
    content.value[2].children.push({
      suggestion: true,
      suggestion_second_review: {
        id: 'second-review',
        type: 'insert',
        userId: 'u_commenter',
      },
      text: ' second pending addition',
    });
    const committed = await editorApi(
      page,
      `/api/materials/${EDITOR_NOTE.id}/suggestion-commits`,
      {
        body: { content, expectedRevision: materialResponse.body.revision },
        method: 'POST',
      }
    );
    expect(committed.status).toBe(201);

    await page.reload();
    await expect(page.getByText('first pending addition')).toBeVisible();
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .first()
      .click();
    const popover = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(
      popover.getByText('first pending addition', { exact: true })
    ).toBeVisible();
    await popover.getByRole('button', { exact: true, name: 'Accept' }).click();

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor.locator('ins')).toHaveCount(1);
    await expect(editor).toContainText('first pending addition');
    await expect(editor).toContainText('second pending addition');
    await page.keyboard.press('Escape');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { exact: true, name: 'Reject all' }).click();
    await expect(editor.locator('ins')).toHaveCount(0);
    await expect(editor).toContainText('first pending addition');
    await expect(editor).not.toContainText('second pending addition');
    await expect(
      page.getByRole('button', { exact: true, name: 'Reject all' })
    ).toHaveCount(0);
  });

  test('raw Plate metadata is synthesized as a recoverable orphan in its block', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const materialResponse = await editorApi<any>(
      page,
      `/api/materials/${EDITOR_NOTE.id}`
    );
    const content = structuredClone(materialResponse.body.content);
    content.value[1].children.push({
      suggestion: true,
      suggestion_raw_orphan: {
        id: 'raw-orphan',
        type: 'insert',
        userId: 'missing-user',
      },
      text: ' orphaned raw change',
    });
    const patched = await editorApi(page, `/api/materials/${EDITOR_NOTE.id}`, {
      body: { content, expectedRevision: materialResponse.body.revision },
      method: 'PATCH',
    });
    expect(patched.status).toBe(200);

    await page.reload();
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const popover = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await expect(
      popover.getByText('Suggestion from Unknown user · missing lifecycle', {
        exact: true,
      })
    ).toBeVisible();
    await expect(
      popover.getByText('orphaned raw change', { exact: true })
    ).toBeVisible();
    await expect(
      popover.getByRole('button', { exact: true, name: 'Accept' })
    ).toBeVisible();
    await expect(
      popover.getByRole('button', { exact: true, name: 'Withdraw' })
    ).toHaveCount(0);
  });

  test('a reply renders one level deep without another Reply control', async ({
    page,
  }) => {
    await openEditorNote(page, EDITOR_NOTE.id, EDITOR_NOTE.firstParagraph);
    const created = await editorApi<any>(
      page,
      `/api/materials/${EDITOR_NOTE.id}/discussions`,
      {
        body: {
          anchor: { blockId: `${EDITOR_NOTE.id}:first` },
          blockId: `${EDITOR_NOTE.id}:first`,
          contentRich: [
            { children: [{ text: 'Root editor comment' }], type: 'p' },
          ],
        },
        method: 'POST',
      }
    );
    expect(created.status).toBe(201);

    await page.reload();
    await page
      .getByRole('button', { name: 'Show 1 collaboration item' })
      .click();
    const popover = page
      .getByRole('dialog')
      .filter({ hasText: 'Comments & suggestions' });
    await popover.getByRole('button', { exact: true, name: 'Reply' }).click();
    await popover
      .getByRole('textbox', { name: 'Reply' })
      .fill('One-level reply');
    await popover
      .getByRole('button', { exact: true, name: 'Reply' })
      .last()
      .click();

    await expect(
      popover.getByText('One-level reply', { exact: true })
    ).toBeVisible();
    await expect(
      popover.getByRole('button', { exact: true, name: 'Reply' })
    ).toHaveCount(1);
  });
});
