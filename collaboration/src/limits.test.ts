import { slateNodesToInsertDelta } from '@slate-yjs/core';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MATERIAL_DOCUMENT_LIMITS,
  MaterialDocumentLimitError,
  materialLimitCode,
  measureMaterialValue,
  recoversMaterialLimits,
} from './limits.js';
import { YjsDocumentStore } from './persistence.js';

function paragraph(text: string) {
  return { children: [{ text }], type: 'p' };
}

function nestedParagraph(depth: number) {
  let node: Record<string, unknown> = { text: 'bottom' };
  for (let level = 0; level < depth; level += 1) {
    node = { children: [node], type: 'blockquote' };
  }
  return node;
}

function documentWithValue(value: unknown[]) {
  const document = new Y.Doc({ gc: true });
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  return document;
}

function updateReplacingValue(base: Y.Doc, value: unknown[]) {
  const next = new Y.Doc({ gc: true });
  Y.applyUpdate(next, Y.encodeStateAsUpdate(base));
  const content = next.get('content', Y.XmlText);
  content.delete(0, content.length);
  content.applyDelta(slateNodesToInsertDelta(value as never));
  const update = Y.encodeStateAsUpdate(next, Y.encodeStateVector(base));
  next.destroy();
  return update;
}

// Update validation never touches PostgreSQL; only load/store do.
function validator() {
  return new YjsDocumentStore({} as Pool);
}

const room = 'material:abc:schema:1';

describe('material document measurement', () => {
  it('reports depth relative to the top-level blocks', () => {
    const metrics = measureMaterialValue([
      {
        children: [{ children: [{ text: 'deep' }], type: 'p' }],
        type: 'blockquote',
      },
    ]);
    expect(metrics.nodeCount).toBe(3);
    expect(metrics.maxDepth).toBe(2);
    expect(metrics.contentBytes).toBeGreaterThan(0);
  });

  it('measures every node in a structurally valid deep document', () => {
    const metrics = measureMaterialValue([nestedParagraph(300)]);

    expect(metrics.maxDepth).toBe(300);
    expect(metrics.nodeCount).toBe(301);
  });

  it('names the limit that a document breaks', () => {
    expect(
      materialLimitCode(measureMaterialValue([paragraph('ok')]))
    ).toBeNull();
    expect(
      materialLimitCode({
        contentBytes: MATERIAL_DOCUMENT_LIMITS.maxContentBytes + 1,
        maxDepth: 1,
        nodeCount: 1,
      })
    ).toBe('document_size_exceeded');
    expect(
      materialLimitCode({
        contentBytes: 1,
        maxDepth: MATERIAL_DOCUMENT_LIMITS.maxDepth + 1,
        nodeCount: 1,
      })
    ).toBe('document_depth_exceeded');
  });

  it('excludes runtime comment marks from persisted content metrics', () => {
    const clean = [
      {
        children: [{ bold: true, commentary: 'kept', text: 'annotated' }],
        id: 'block_1',
        type: 'p',
      },
    ];
    const runtimeMarked = [
      {
        children: [
          {
            bold: true,
            comment: 'discussion_1',
            comment_thread_1: true,
            commentary: 'kept',
            text: 'annotated',
          },
        ],
        id: 'block_1',
        type: 'p',
      },
    ];

    expect(measureMaterialValue(runtimeMarked)).toEqual(
      measureMaterialValue(clean)
    );
  });
});

describe('recovering an over-limit document', () => {
  const previous = { contentBytes: 100, maxDepth: 4, nodeCount: 10 };

  it('accepts an edit that does not worsen any dimension', () => {
    expect(
      recoversMaterialLimits(
        { contentBytes: 90, maxDepth: 4, nodeCount: 9 },
        previous
      )
    ).toBe(true);
    expect(recoversMaterialLimits(previous, previous)).toBe(true);
  });

  it('rejects an edit that worsens a single dimension', () => {
    expect(
      recoversMaterialLimits(
        { contentBytes: 90, maxDepth: 5, nodeCount: 9 },
        previous
      )
    ).toBe(false);
  });

  it('rejects anything without a baseline to compare against', () => {
    expect(recoversMaterialLimits(previous, null)).toBe(false);
  });
});

describe('inbound update validation', () => {
  it('rejects arbitrary top-level Yjs roots', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    const attacker = new Y.Doc({ gc: true });
    Y.applyUpdate(attacker, Y.encodeStateAsUpdate(document));
    attacker.getText('unmetered').insert(0, 'hidden growth');
    const update = Y.encodeStateAsUpdate(
      attacker,
      Y.encodeStateVector(document)
    );

    expect(() => store.validateUpdate(room, document, update)).toThrow(
      'unsupported collaboration document root: unmetered'
    );

    attacker.destroy();
    document.destroy();
  });

  it('rejects an update that pushes the document past a limit', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    const oversized = Array.from(
      { length: MATERIAL_DOCUMENT_LIMITS.maxNodes },
      (_, index) => paragraph(`block ${index}`)
    );
    const update = updateReplacingValue(document, oversized);
    expect(() => store.validateUpdate(room, document, update)).toThrow(
      MaterialDocumentLimitError
    );
  });

  it('still accepts deletions once the document is already over a limit', () => {
    const store = validator();
    const oversized = Array.from(
      { length: MATERIAL_DOCUMENT_LIMITS.maxNodes + 100 },
      (_, index) => paragraph(`block ${index}`)
    );
    const document = documentWithValue(oversized);
    const update = updateReplacingValue(document, [paragraph('recovered')]);
    expect(() => store.validateUpdate(room, document, update)).not.toThrow();
  });

  it('reports the metrics that caused the rejection', () => {
    const store = validator();
    const document = documentWithValue([paragraph('small')]);
    let depth: unknown[] = [{ children: [{ text: 'bottom' }], type: 'p' }];
    for (
      let level = 0;
      level <= MATERIAL_DOCUMENT_LIMITS.maxDepth;
      level += 1
    ) {
      depth = [{ children: depth, type: 'blockquote' }];
    }
    const update = updateReplacingValue(document, depth);
    try {
      store.validateUpdate(room, document, update);
      expect.unreachable('expected the nesting limit to be enforced');
    } catch (error) {
      expect(error).toBeInstanceOf(MaterialDocumentLimitError);
      expect((error as MaterialDocumentLimitError).code).toBe(
        'document_depth_exceeded'
      );
      expect(
        (error as MaterialDocumentLimitError).metrics.maxDepth
      ).toBeGreaterThan(MATERIAL_DOCUMENT_LIMITS.maxDepth);
    }
  });

  it('rejects deep-branch growth hidden behind otherwise shrinking content', () => {
    const store = validator();
    const document = documentWithValue([
      nestedParagraph(300),
      ...Array.from({ length: 1000 }, (_, index) =>
        paragraph(`discarded sibling ${index}`)
      ),
    ]);
    const update = updateReplacingValue(document, [nestedParagraph(301)]);

    expect(() =>
      store.validateUpdate(room, document, update, { shrinkOnly: true })
    ).toThrow(MaterialDocumentLimitError);

    document.destroy();
  });
});
