import { describe, expect, it } from 'vitest';

import {
  createMaterialDocument,
  createMaterialDocumentWithMetrics,
  isMaterialDocument,
  normalizeMaterialValue,
  normalizeMaterialValueWithMetrics,
  parseMaterialDocument,
  parseMaterialDocumentWithMetrics,
} from './document';

describe('Universal Plate material documents', () => {
  it('adds stable ids to every element while preserving existing ids', () => {
    const value = normalizeMaterialValue([
      {
        children: [{ children: [{ text: 'Annotatable child' }], type: 'p' }],
        id: 'existing',
        type: 'blockquote',
      },
    ]);

    expect(value[0].id).toBe('existing');
    expect(value[0].children[0]).toMatchObject({
      id: expect.any(String),
      type: 'p',
    });
  });

  it('repairs duplicate top-level ids at the persistence boundary', () => {
    const value = normalizeMaterialValue([
      { children: [{ text: 'One' }], id: 'duplicate', type: 'p' },
      { children: [{ text: 'Two' }], id: 'duplicate', type: 'p' },
    ]);

    expect(value[0].id).toBe('duplicate');
    expect(value[1].id).not.toBe('duplicate');
    expect(value[1].id).toEqual(expect.any(String));
  });

  it('strips runtime comment decorations but preserves ordinary marks', () => {
    const document = createMaterialDocument([
      {
        children: [
          {
            bold: true,
            comment: true,
            comment_discussion: true,
            text: 'Annotated',
          },
        ],
        type: 'p',
      },
    ]);

    expect(document.value[0].children[0]).toEqual({
      bold: true,
      text: 'Annotated',
    });
  });

  it('round-trips a versioned Plate document', () => {
    const document = createMaterialDocument([
      { children: [{ bold: true, text: 'Hello' }], type: 'p' },
    ]);

    expect(isMaterialDocument(document)).toBe(true);
    expect(parseMaterialDocument(JSON.stringify(document))).toEqual(document);
  });

  it('collects normalized node count and depth without a second metrics walk', () => {
    const result = createMaterialDocumentWithMetrics([
      {
        children: [{ children: [{ text: 'Nested' }], type: 'p' }],
        type: 'blockquote',
      },
    ]);

    expect(result.metrics).toEqual({ maxDepth: 2, nodeCount: 3 });
    expect(result.document.value[0].id).toEqual(expect.any(String));
    expect(createMaterialDocument(result.document.value)).toEqual(
      result.document
    );
    expect(parseMaterialDocument(result.document)).toEqual(result.document);
  });

  it('normalized values never alias the input nodes', () => {
    const source = [
      {
        children: [
          { children: [{ text: 'const answer = 42;' }], type: 'code_line' },
        ],
        type: 'code_block',
      },
    ];

    const result = normalizeMaterialValueWithMetrics(source as never);

    expect(result.metrics).toEqual({ maxDepth: 2, nodeCount: 3 });
    expect(result.value[0]).not.toBe(source[0]);
    expect(result.value[0].children[0]).not.toBe(source[0].children[0]);
    expect(result.value[0].children[0]).toMatchObject({
      id: expect.any(String),
      type: 'code_line',
    });
  });

  it('returns metrics when parsing a persisted document', () => {
    const source = createMaterialDocument([
      { children: [{ text: 'Persisted' }], type: 'p' },
    ]);

    const parsed = parseMaterialDocumentWithMetrics(source);

    expect(parsed?.document).toEqual(source);
    expect(parsed?.metrics).toEqual({ maxDepth: 1, nodeCount: 2 });
  });

  it('validates deeply nested documents in linear time', () => {
    // Regression: validation used to recurse into children from both
    // isElementNode and isMaterialNode, doubling the work per nesting level
    // (~2^depth). At this depth the old validator would effectively hang.
    let node = { children: [{ text: 'leaf' }], type: 'p' } as never;
    for (let depth = 0; depth < 40; depth += 1) {
      node = { children: [node], type: 'blockquote' } as never;
    }

    const start = performance.now();
    expect(isMaterialDocument({ schemaVersion: 1, value: [node] })).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('rejects media URLs and requires a persistent asset id', () => {
    const document = {
      schemaVersion: 1,
      value: [
        {
          assetId: 'asset-1',
          children: [{ text: '' }],
          id: 'image-1',
          type: 'img',
          url: 'https://signed.example/temporary',
        },
      ],
    };

    expect(isMaterialDocument(document)).toBe(false);
    expect(
      isMaterialDocument({
        ...document,
        value: [{ ...document.value[0], url: undefined }],
      })
    ).toBe(true);
  });

  it('accepts only validated YouTube video nodes', () => {
    const node = {
      children: [{ text: '' }],
      provider: 'youtube',
      type: 'video',
      videoId: 'dQw4w9WgXcQ',
    };
    expect(isMaterialDocument({ schemaVersion: 1, value: [node] })).toBe(true);
    expect(
      isMaterialDocument({
        schemaVersion: 1,
        value: [{ ...node, videoId: 'not-valid' }],
      })
    ).toBe(false);
  });
});
