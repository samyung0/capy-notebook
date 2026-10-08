import { describe, expect, it } from 'vitest';
import {
  customBlockCode,
  customBlockNode,
} from '@/features/notes/blocks/shared';
import { exampleQuestion } from '@/features/questions/questionFixtures';

import {
  createMaterialDocument,
  createMaterialDocumentWithMetrics,
  HTML_EMBED_MAX_BYTES,
  htmlEmbedNode,
  isMaterialDocument,
  isMaterialRefElement,
  type MaterialValue,
  materialRefNode,
  normalizeMaterialValue,
  normalizeMaterialValueWithMetrics,
  parseMaterialDocument,
  parseMaterialDocumentWithMetrics,
  quizNode,
} from './document';

describe('Universal Plate material documents', () => {
  it('keeps figure data through the note JSON and Markdown fence boundaries', () => {
    const node = customBlockNode(
      'chart',
      JSON.stringify({
        kind: 'bar',
        labels: ['A'],
        series: [{ name: 'Total', values: [3] }],
        title: 'Counts',
        type: 'chart',
      })
    );
    const document = createMaterialDocument([node]);
    expect(parseMaterialDocument(JSON.stringify(document))).toEqual(document);
    expect(customBlockCode(node)).toContain('"values":[3]');
    expect(
      isMaterialDocument({
        schemaVersion: 1,
        value: [{ ...node, type: 'graph' }],
      })
    ).toBe(false);
  });
  it('caps interactive blocks at 64 KB of html and 10 per document', () => {
    const embeds = (count: number, html = '<p>x</p>') =>
      Array.from({ length: count }, (_, i) => htmlEmbedNode(html, '', `e${i}`));
    const doc = (value: MaterialValue) => ({ schemaVersion: 1, value });
    expect(isMaterialDocument(doc(embeds(10)))).toBe(true);
    expect(isMaterialDocument(doc(embeds(11)))).toBe(false);
    expect(
      isMaterialDocument(doc(embeds(1, 'é'.repeat(HTML_EMBED_MAX_BYTES / 2))))
    ).toBe(true);
    expect(
      isMaterialDocument(
        doc(embeds(1, 'é'.repeat(HTML_EMBED_MAX_BYTES / 2 + 1)))
      )
    ).toBe(false);
  });
  it('rejects shared part IDs across different quiz blocks', () => {
    const first = exampleQuestion('one');
    const second = exampleQuestion('two');
    second.parts[0].id = first.parts[0].id;
    expect(
      isMaterialDocument({
        schemaVersion: 1,
        value: [
          quizNode({ questions: [first] }),
          quizNode({ questions: [second] }),
        ],
      })
    ).toBe(false);
  });
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

  // As the Node and Go validators: an imported document with any other
  // width fails here instead of getting the note's room refused.
  it('takes only the resize width on resizable blocks', () => {
    const leaf = [{ text: '' }];
    const blocks = [
      { assetId: 'asset', children: leaf, id: 'b', type: 'img' },
      {
        children: leaf,
        id: 'b',
        provider: 'youtube',
        type: 'video',
        videoId: 'dQw4w9WgXcQ',
      },
      {
        children: [{ children: leaf, type: 'mermaid_caption' }],
        id: 'b',
        source: 'flowchart LR',
        type: 'mermaid',
      },
    ];
    const valid = (block: object, width: unknown) =>
      isMaterialDocument({ schemaVersion: 1, value: [{ ...block, width }] });
    for (const block of blocks) {
      for (const width of [undefined, '20%', '55%', '100%'])
        expect(valid(block, width)).toBe(true);
      for (const width of ['19%', '101%', 50, '50px', '50.5%', '050%', null])
        expect(valid(block, width)).toBe(false);
    }
    // Plate's chart and graph nodes use the same rule.
    const chart = customBlockNode(
      'chart',
      JSON.stringify({
        kind: 'bar',
        labels: ['A'],
        series: [{ name: 'Total', values: [3] }],
        title: 'Counts',
        type: 'chart',
      })
    );
    expect(valid(chart, '40%')).toBe(true);
    expect(valid(chart, 300)).toBe(false);
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

  it('rejects fill as a question type', () => {
    expect(
      isMaterialDocument({
        schemaVersion: 1,
        value: [
          {
            children: [
              {
                children: [{ children: [{ text: '?' }], type: 'quiz_prompt' }],
                id: 'q1',
                level: 'recall',
                questionType: 'fill',
                type: 'quiz_question',
              },
            ],
            id: 'quiz_1',
            type: 'quiz',
          },
        ],
      })
    ).toBe(false);
  });
});

describe('embedded material references', () => {
  it('accepts a resolved or pending reference and rejects a malformed one', () => {
    const resolved = materialRefNode('mat_child', 'quiz');
    expect(isMaterialDocument(createMaterialDocument([resolved]))).toBe(true);
    const pending = materialRefNode('', 'flashcards', 'cards: []');
    expect(isMaterialDocument(createMaterialDocument([pending]))).toBe(true);
    expect(isMaterialRefElement(resolved)).toBe(true);
    for (const broken of [
      { ...resolved, materialId: '' },
      { ...resolved, refKind: 'note' },
      { ...resolved, children: [{ text: 'x' }] },
    ]) {
      expect(isMaterialDocument({ schemaVersion: 1, value: [broken] })).toBe(
        false
      );
    }
  });
});
