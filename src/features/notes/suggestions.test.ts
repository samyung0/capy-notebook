import { describe, expect, it } from 'vitest';
import type { MaterialValue } from '@/features/materials/document';
import {
  finalizeSuggestionValue,
  resolveSuggestions,
  scanSuggestions,
  stripCommentDecorations,
  suggestionIds,
} from './suggestions';

const marked = [
  {
    children: [
      { text: 'Keep ' },
      {
        suggestion: true,
        suggestion_replace: { id: 'replace', type: 'remove', userId: 'u' },
        text: 'old',
      },
      {
        bold: true,
        suggestion: true,
        suggestion_replace: { id: 'replace', type: 'insert', userId: 'u' },
        text: 'new',
      },
      {
        bold: true,
        suggestion: true,
        suggestion_style: {
          id: 'style',
          newProperties: { italic: true },
          properties: { bold: true },
          type: 'update',
        },
        text: 'styled',
      },
    ],
    id: 'block-a',
    type: 'p',
  },
  {
    assetId: 'asset-1',
    children: [{ text: '' }],
    id: 'block-b',
    suggestion: { id: 'void', type: 'insert', userId: 'u' },
    type: 'img',
  },
] as MaterialValue;

describe('scanSuggestions', () => {
  it('groups repeated inline marks by Plate ID and block', () => {
    expect(scanSuggestions(marked)).toEqual([
      {
        blockId: 'block-a',
        metadata: [
          { id: 'replace', operation: 'remove', userId: 'u' },
          { id: 'replace', operation: 'insert', userId: 'u' },
        ],
        operation: 'replace',
        plateSuggestionId: 'replace',
        previewAfter: 'new',
        previewBefore: 'old',
        userId: 'u',
      },
      {
        blockId: 'block-a',
        metadata: [
          {
            id: 'style',
            newProperties: { italic: true },
            operation: 'update',
            properties: { bold: true },
          },
        ],
        operation: 'update',
        plateSuggestionId: 'style',
        previewAfter: '{"italic":true}',
        previewBefore: '{"bold":true}',
      },
      {
        blockId: 'block-b',
        metadata: [{ id: 'void', operation: 'insert', userId: 'u' }],
        operation: 'insert',
        plateSuggestionId: 'void',
        previewAfter: 'Image',
        previewBefore: '',
        userId: 'u',
      },
    ]);
    expect([...suggestionIds(marked)].sort()).toEqual([
      'replace',
      'style',
      'void',
    ]);
  });

  it('groups one Plate ID independently in each top-level block', () => {
    const value = [
      {
        children: [
          {
            suggestion: true,
            suggestion_x: { id: 'x', type: 'insert' },
            text: 'one',
          },
        ],
        id: 'a',
        type: 'p',
      },
      {
        children: [
          {
            suggestion: true,
            suggestion_x: { id: 'x', type: 'insert' },
            text: 'two',
          },
        ],
        id: 'b',
        type: 'p',
      },
    ] as MaterialValue;
    expect(scanSuggestions(value)).toHaveLength(2);
  });

  it('requires stable block IDs and concrete Plate metadata', () => {
    const value = [
      {
        children: [
          { suggestion: true, text: 'missing metadata' },
          {
            suggestion: true,
            suggestion_real: { id: 'real', type: 'insert' },
            text: 'real',
          },
        ],
        type: 'p',
      },
      {
        children: [{ suggestion: true, text: 'decoration only' }],
        id: 'stable',
        type: 'p',
      },
    ] as MaterialValue;

    expect(scanSuggestions(value)).toEqual([]);
  });

  it('retains author, creation time, and typed source metadata for the UI', () => {
    const value = [
      {
        children: [
          {
            suggestion: true,
            suggestion_created: {
              createdAt: '2026-07-25T01:00:00.000Z',
              id: 'created',
              type: 'insert',
              userId: 'u_author',
            },
            text: 'new',
          },
        ],
        id: 'block-a',
        type: 'p',
      },
    ] as MaterialValue;

    expect(scanSuggestions(value)[0]).toMatchObject({
      createdAt: '2026-07-25T01:00:00.000Z',
      metadata: [
        {
          createdAt: '2026-07-25T01:00:00.000Z',
          id: 'created',
          operation: 'insert',
          userId: 'u_author',
        },
      ],
      userId: 'u_author',
    });
  });

  it('scans insert, remove, replace, update, block, line-break, and void metadata', () => {
    const value = [
      {
        children: [
          {
            suggestion: true,
            suggestion_insert: { id: 'insert', type: 'insert' },
            text: 'add',
          },
          {
            suggestion: true,
            suggestion_remove: { id: 'remove', type: 'remove' },
            text: 'remove',
          },
          {
            suggestion: true,
            suggestion_replace: { id: 'replace', type: 'remove' },
            text: 'old',
          },
          {
            suggestion: true,
            suggestion_replace: { id: 'replace', type: 'insert' },
            text: 'new',
          },
          {
            suggestion: true,
            suggestion_update: {
              id: 'update',
              newProperties: { italic: true },
              properties: { bold: true },
              type: 'update',
            },
            text: 'styled',
          },
        ],
        id: 'inline',
        type: 'p',
      },
      {
        children: [{ text: 'whole block' }],
        id: 'block',
        suggestion: { id: 'block-change', type: 'insert' },
        type: 'h2',
      },
      {
        children: [{ text: '' }],
        id: 'line',
        suggestion: { id: 'line-break', isLineBreak: true, type: 'insert' },
        type: 'p',
      },
      {
        children: [{ text: '' }],
        id: 'void',
        suggestion: { id: 'void-change', type: 'remove' },
        type: 'img',
        url: 'https://example.test/image.png',
      },
    ] as MaterialValue;

    const changes = Object.fromEntries(
      scanSuggestions(value).map((change) => [change.plateSuggestionId, change])
    );
    expect(Object.keys(changes).sort()).toEqual([
      'block-change',
      'insert',
      'line-break',
      'remove',
      'replace',
      'update',
      'void-change',
    ]);
    expect(changes.insert).toMatchObject({
      blockId: 'inline',
      operation: 'insert',
      previewAfter: 'add',
    });
    expect(changes.remove).toMatchObject({
      blockId: 'inline',
      operation: 'remove',
      previewBefore: 'remove',
    });
    expect(changes.replace).toMatchObject({
      operation: 'replace',
      previewAfter: 'new',
      previewBefore: 'old',
    });
    expect(changes.update).toMatchObject({
      operation: 'update',
      previewAfter: '{"italic":true}',
      previewBefore: '{"bold":true}',
    });
    expect(changes['block-change']).toMatchObject({
      blockId: 'block',
      operation: 'insert',
      previewAfter: 'whole block',
    });
    expect(changes['line-break']).toMatchObject({
      blockId: 'line',
      operation: 'insert',
      previewAfter: '(line break)',
      previewBefore: '',
    });
    expect(changes['void-change']).toMatchObject({
      blockId: 'void',
      operation: 'remove',
    });
  });
});

describe('stripCommentDecorations', () => {
  it('removes runtime comment marks without touching suggestion metadata', () => {
    const value = [
      {
        children: [
          {
            comment: true,
            comment_discussion: true,
            suggestion: true,
            suggestion_change: { id: 'change', type: 'insert' },
            text: 'annotated',
          },
        ],
        id: 'block',
        type: 'p',
      },
    ] as MaterialValue;

    expect(stripCommentDecorations(value)).toEqual([
      {
        children: [
          {
            suggestion: true,
            suggestion_change: { id: 'change', type: 'insert' },
            text: 'annotated',
          },
        ],
        id: 'block',
        type: 'p',
      },
    ]);
    expect(value[0].children[0]).toHaveProperty('comment', true);
  });
});

describe('resolveSuggestions', () => {
  it('accepts all insertions, removals, replacements, and updates', () => {
    expect(finalizeSuggestionValue(marked, 'accept')).toEqual([
      {
        children: [
          { text: 'Keep ' },
          { bold: true, text: 'new' },
          { italic: true, text: 'styled' },
        ],
        id: 'block-a',
        type: 'p',
      },
      {
        assetId: 'asset-1',
        children: [{ text: '' }],
        id: 'block-b',
        type: 'img',
      },
    ]);
  });

  it('rejects all changes back to a clean projection', () => {
    expect(finalizeSuggestionValue(marked, 'reject')).toEqual([
      {
        children: [{ text: 'Keep old' }, { bold: true, text: 'styled' }],
        id: 'block-a',
        type: 'p',
      },
    ]);
  });

  it('resolves selected IDs while preserving other pending marks', () => {
    const result = resolveSuggestions(marked, 'accept', ['style']);
    expect(result.resolvedIds).toEqual(['style']);
    expect(result.hasPendingSuggestions).toBe(true);
    expect(suggestionIds(result.value)).toEqual(new Set(['replace', 'void']));
  });

  it('rejects one selected ID while preserving every unselected mark', () => {
    const result = resolveSuggestions(marked, 'reject', ['replace']);
    expect(result.resolvedIds).toEqual(['replace']);
    expect(result.hasPendingSuggestions).toBe(true);
    expect(suggestionIds(result.value)).toEqual(new Set(['style', 'void']));
    expect(result.value[0].children).toEqual([
      { text: 'Keep old' },
      {
        bold: true,
        suggestion: true,
        suggestion_style: {
          id: 'style',
          newProperties: { italic: true },
          properties: { bold: true },
          type: 'update',
        },
        text: 'styled',
      },
    ]);
  });

  it('preserves a valid Slate root when rejecting the only inserted block', () => {
    const value = [
      {
        children: [{ text: '' }],
        suggestion: { id: 'only', type: 'insert' },
        type: 'p',
      },
    ] as MaterialValue;
    expect(resolveSuggestions(value, 'reject').value).toEqual([
      { children: [{ text: '' }], type: 'p' },
    ]);
  });

  it('coalesces equivalent text leaves after rejecting a split replacement', () => {
    const value = [
      {
        children: [
          { text: 'before ' },
          {
            suggestion: true,
            suggestion_replace: { id: 'split-replace', type: 'remove' },
            text: 'old',
          },
          {
            suggestion: true,
            suggestion_replace: { id: 'split-replace', type: 'insert' },
            text: 'new',
          },
          { text: ' after' },
        ],
        id: 'split',
        type: 'p',
      },
    ] as MaterialValue;
    expect(resolveSuggestions(value, 'reject').value).toEqual([
      { children: [{ text: 'before old after' }], id: 'split', type: 'p' },
    ]);
  });
});
