import { BaseSuggestionPlugin } from '@platejs/suggestion';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import type { MaterialDiscussion, MaterialSuggestion } from '@/api/types';
import type { MaterialValue } from '@/features/materials/document';
import {
  commentDiscussionAnchor,
  joinActiveSuggestions,
  suggestionControlPermissions,
  synthesizeDraftSuggestions,
  synthesizeOrphanSuggestions,
} from './Collaboration';
import { canReplyAtDepth } from './canReplyAtDepth';
import {
  buildCollaborationPlugins,
  suggestionSafeTrailingBlockPlugin,
} from './collaborationPlugins';

function createSuggestingEditor(
  value?: Array<{ type: string; children: Array<{ text: string }> }>
) {
  return createPlateEditor({
    plugins: buildCollaborationPlugins({
      currentUserId: 'u_commenter',
      discussions: [],
      mode: 'suggestion',
      users: {},
    }),
    value: value ?? [{ children: [{ text: 'Original sentence' }], type: 'p' }],
  });
}

describe('buildCollaborationPlugins suggestion mode', () => {
  it('keeps the block discussion button renderer alongside runtime options', () => {
    const editor = createSuggestingEditor();
    const plugin = editor.getPlugin({ key: 'evo-discussions' }) as {
      node?: { aboveComponent?: unknown };
      render?: { aboveNodes?: unknown };
    };

    expect(
      plugin.node?.aboveComponent ?? plugin.render?.aboveNodes
    ).toBeTruthy();
  });

  it('keeps the comment renderer and shortcut in the resolved plugin', () => {
    // Stable comment behavior must not live in Plate's single `.configure()`
    // slot, or a future runtime options configuration will replace it.
    const editor = createSuggestingEditor();
    const plugin = editor.getPlugin({ key: 'comment' }) as {
      node?: { component?: unknown };
      render?: { node?: unknown };
      shortcuts?: { setDraft?: { keys?: string } };
    };
    expect(plugin.node?.component ?? plugin.render?.node).toBeTruthy();
    expect(plugin.shortcuts?.setDraft?.keys).toBe('mod+shift+m');
    expect(
      (plugin as { handlers?: { onClick?: unknown } }).handlers?.onClick
    ).toBeTruthy();
  });

  it('resolves the configured author and suggesting state', () => {
    const editor = createSuggestingEditor();
    const options = editor.getOptions(BaseSuggestionPlugin);
    // Regression: a creation-time function config on the plugin used to
    // overwrite currentUserId with '', so the normalizer treated every typed
    // suggestion as authorless and deleted it immediately.
    expect(options.currentUserId).toBe('u_commenter');
    expect(options.isSuggesting).toBe(true);
  });

  it('keeps the ins/del leaf renderer alongside runtime options', () => {
    // Regression: Plate plugins hold a single `.configure()` slot, so the
    // runtime configure({ options }) used to wipe out a module-level
    // configure({ render }) and suggestions rendered as plain spans.
    const editor = createSuggestingEditor();
    const plugin = editor.getPlugin({ key: 'suggestion' }) as {
      node?: { component?: unknown };
      render?: { node?: unknown; leaf?: unknown };
    };
    expect(
      plugin.node?.component ?? plugin.render?.leaf ?? plugin.render?.node
    ).toBeTruthy();
    expect(
      (plugin as { handlers?: { onClick?: unknown } }).handlers?.onClick
    ).toBeTruthy();
  });

  it('keeps typed text as an authored insert suggestion', () => {
    const editor = createSuggestingEditor();
    const end = { offset: 'Original sentence'.length, path: [0, 0] };
    editor.tf.select({ anchor: end, focus: end });
    editor.tf.insertText(' improved');

    const leaves = (
      editor.children[0] as { children: Record<string, unknown>[] }
    ).children;
    const inserted = leaves.find(
      (leaf) => typeof leaf.text === 'string' && leaf.text.includes('improved')
    );
    expect(inserted?.suggestion).toBe(true);
    const data = editor
      .getApi(BaseSuggestionPlugin)
      .suggestion.dataList(inserted as never);
    expect(data.at(-1)).toMatchObject({
      type: 'insert',
      userId: 'u_commenter',
    });
  });

  it('marks deleted text instead of removing it', () => {
    const editor = createSuggestingEditor();
    editor.tf.select({
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 'Original'.length, path: [0, 0] },
    });
    editor.tf.deleteFragment();

    const leaves = (
      editor.children[0] as { children: Record<string, unknown>[] }
    ).children;
    const removed = leaves.find((leaf) => leaf.text === 'Original');
    expect(removed?.suggestion).toBe(true);
    const data = editor
      .getApi(BaseSuggestionPlugin)
      .suggestion.dataList(removed as never);
    expect(data.at(-1)).toMatchObject({
      type: 'remove',
      userId: 'u_commenter',
    });
  });

  it('preserves an existing pending ID while editing its inserted range', () => {
    const editor = createSuggestingEditor([
      {
        children: [
          {
            suggestion: true,
            suggestion_existing: {
              id: 'existing',
              type: 'insert',
              userId: 'u_commenter',
            },
            text: 'pending text',
          } as never,
        ],
        type: 'p',
      },
    ]);
    const point = { offset: 'pending'.length, path: [0, 0] };
    editor.tf.select({ anchor: point, focus: point });
    editor.tf.insertText(' updated');

    const leaves = (
      editor.children[0] as { children: Record<string, unknown>[] }
    ).children;
    const edited = leaves.find((leaf) => String(leaf.text).includes('updated'));
    const data = editor
      .getApi(BaseSuggestionPlugin)
      .suggestion.dataList(edited as never);
    expect(data.at(-1)).toMatchObject({ id: 'existing', type: 'insert' });
  });

  it('does not mark a value reset as a whole-document suggestion', () => {
    // Regression: replacing the document (draft restore, remote refresh) while
    // isSuggesting was on recorded "delete everything + re-insert everything".
    const editor = createSuggestingEditor();
    editor.getApi(BaseSuggestionPlugin).suggestion.withoutSuggestions(() => {
      editor.tf.setValue([
        { children: [{ text: 'Fresh content' }], type: 'p' },
      ]);
    });

    const collectMarked = (nodes: unknown[]): unknown[] =>
      nodes.flatMap((node) => {
        if (!node || typeof node !== 'object') return [];
        const record = node as Record<string, unknown>;
        const own =
          record.suggestion ||
          Object.keys(record).some((key) => key.startsWith('suggestion_'))
            ? [record]
            : [];
        return Array.isArray(record.children)
          ? [...own, ...collectMarked(record.children)]
          : own;
      });

    expect(collectMarked(editor.children)).toEqual([]);
  });
});

describe('suggestionSafeTrailingBlockPlugin', () => {
  it('does not mark the auto-appended trailing paragraph as a suggestion', () => {
    // Regression: every suggestion-mode edit appeared to append a phantom
    // final line because TrailingBlockPlugin's insert ran as a user edit.
    const editor = createPlateEditor({
      plugins: [
        ...buildCollaborationPlugins({
          currentUserId: 'u_commenter',
          discussions: [],
          mode: 'suggestion',
          users: {},
        }),
        suggestionSafeTrailingBlockPlugin,
      ],
      // A trailing non-paragraph block forces the plugin to append one.
      value: [{ children: [{ text: 'Title' }], type: 'h1' }],
    });

    editor.tf.normalize({ force: true });

    const last = editor.children.at(-1) as Record<string, unknown>;
    expect(last.type).toBe('p');
    expect(last.suggestion).toBeUndefined();
    expect(Object.keys(last).some((key) => key.startsWith('suggestion_'))).toBe(
      false
    );
    const leaf = (last.children as Record<string, unknown>[])[0];
    expect(leaf.suggestion).toBeUndefined();
  });
});

describe('collaboration projection controls', () => {
  const pendingSuggestion = {
    commitRevision: 2,
    createdAt: '2026-01-01T00:00:00Z',
    discussionId: 'discussion-row',
    id: 'suggestion-row',
    isDeleted: false,
    plateSuggestionId: 'known',
    status: 'pending',
    updatedAt: '2026-01-01T00:00:00Z',
    userId: 'u_author',
  } satisfies MaterialSuggestion;

  const discussion = {
    anchor: {},
    blockId: 'block-a',
    comments: [],
    createdAt: '2026-01-01T00:00:00Z',
    id: 'discussion-row',
    isDeleted: false,
    isResolved: false,
    kind: 'suggestion',
    materialId: 'material',
    suggestions: [pendingSuggestion],
    updatedAt: '2026-01-01T00:00:00Z',
    userId: 'u_author',
  } satisfies MaterialDiscussion;

  it('synthesizes only raw Plate IDs missing from pending projection rows', () => {
    const value = [
      {
        children: [
          {
            suggestion: true,
            suggestion_known: { id: 'known', type: 'insert' },
            text: 'known text',
          },
          {
            suggestion: true,
            suggestion_orphan: { id: 'orphan', type: 'insert' },
            text: 'orphan text',
          },
        ],
        id: 'block-a',
        type: 'p',
      },
    ] as MaterialValue;

    expect(synthesizeOrphanSuggestions(value, [discussion])).toEqual([
      {
        blockId: 'block-a',
        metadata: [{ id: 'orphan', operation: 'insert' }],
        operation: 'insert',
        orphan: true,
        plateSuggestionId: 'orphan',
        previewAfter: 'orphan text',
        previewBefore: '',
      },
    ]);
  });

  it('uses rich document metadata while joining lifecycle-only fields', () => {
    const value = [
      {
        children: [
          {
            suggestion: true,
            suggestion_known: { id: 'known', type: 'insert' },
            text: 'document preview',
          },
        ],
        id: 'block-a',
        type: 'p',
      },
    ] as MaterialValue;
    const result = joinActiveSuggestions(value, [discussion]);
    expect(result.orphans).toEqual([]);
    expect(result.joined).toHaveLength(1);
    expect(result.joined[0]).toMatchObject({
      blockId: 'block-a',
      operation: 'insert',
      plateSuggestionId: 'known',
      previewAfter: 'document preview',
      previewBefore: '',
    });
    expect(result.joined[0]?.lifecycle).toMatchObject({
      id: 'suggestion-row',
      status: 'pending',
      userId: 'u_author',
    });
    expect(result.joined[0]?.discussion.id).toBe('discussion-row');
  });

  it('does not treat lifecycle rows without rich marks as active', () => {
    const value = [
      {
        children: [{ suggestion: true, text: 'missing metadata' }],
        id: 'block-a',
        type: 'p',
      },
    ] as MaterialValue;

    expect(joinActiveSuggestions(value, [discussion])).toEqual({
      joined: [],
      orphans: [],
    });
  });

  it('classifies live-only suggestion marks as the current user draft', () => {
    const persistedValue = [
      {
        children: [{ text: 'Original text' }],
        id: 'block-a',
        type: 'p',
      },
    ] as MaterialValue;
    const liveValue = structuredClone(persistedValue);
    liveValue[0].children.push({
      suggestion: true,
      suggestion_draft: {
        id: 'draft',
        type: 'insert',
        userId: 'u_author',
      },
      text: ' draft text',
    } as never);

    expect(
      synthesizeDraftSuggestions(liveValue, persistedValue, 'u_author')
    ).toEqual([
      {
        blockId: 'block-a',
        draft: true,
        metadata: [{ id: 'draft', operation: 'insert', userId: 'u_author' }],
        operation: 'insert',
        plateSuggestionId: 'draft',
        previewAfter: 'draft text',
        previewBefore: '',
        userId: 'u_author',
      },
    ]);
  });

  it('only exposes valid comment ranges for comment mark decoration', () => {
    expect(commentDiscussionAnchor(discussion)).toBeNull();

    const range = {
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 4, path: [0, 0] },
    };
    expect(
      commentDiscussionAnchor({
        ...discussion,
        anchor: range,
        kind: 'comment',
      })
    ).toBe(range);
    expect(
      commentDiscussionAnchor({
        ...discussion,
        anchor: { blockId: 'block-a' },
        kind: 'comment',
      })
    ).toBeNull();
    expect(
      commentDiscussionAnchor({
        ...discussion,
        anchor: {
          anchor: { offset: 2, path: [0, 0] },
          focus: { offset: 2, path: [0, 0] },
        },
        kind: 'comment',
      })
    ).toBeNull();
  });

  it('shows review, withdrawal, and reply controls only to permitted roles and depths', () => {
    expect(
      suggestionControlPermissions(pendingSuggestion, 'u_author', false)
    ).toEqual({
      canReview: false,
      canWithdraw: true,
    });
    expect(
      suggestionControlPermissions(pendingSuggestion, 'u_other', false)
    ).toEqual({
      canReview: false,
      canWithdraw: false,
    });
    expect(
      suggestionControlPermissions(pendingSuggestion, 'u_editor', true)
    ).toEqual({
      canReview: true,
      canWithdraw: true,
    });
    expect(canReplyAtDepth(0, true)).toBe(true);
    expect(canReplyAtDepth(1, true)).toBe(false);
    expect(canReplyAtDepth(0, false)).toBe(false);
  });
});
