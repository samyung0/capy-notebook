import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCanonicalMaterialValue,
  HTML_EMBED_MAX_BYTES,
  HTML_EMBED_MAX_COUNT,
  HTML_EMBED_TYPE,
  MaterialDocumentValidationError,
} from './materialDocument.js';

function paragraph(index: number) {
  return {
    children: [{ text: `paragraph ${index}` }],
    id: `block_${index}`,
    type: 'p',
  };
}

function quiz(_timeLimitMin: number) {
  return {
    children: [
      {
        children: [{ text: '' }],
        id: 'question_1',
        question: {
          id: 'question_1',
          labels: 'letters',
          layout: 'paper',
          parts: [
            {
              answer: { correct: true, type: 'boolean' },
              blocks: [{ text: 'True?', type: 'text' }],
              id: 'part_1',
              marks: 1,
              solution: [],
            },
          ],
          stem: [],
        },
        type: 'quiz_question',
      },
    ],
    id: 'quiz_1',
    type: 'quiz',
  };
}

describe('canonical material document validation', () => {
  it('rejects a text leaf that also has children', () => {
    expect(() =>
      assertCanonicalMaterialValue(
        [
          {
            children: [{ children: [], text: 'invalid' }],
            id: 'block_1',
            type: 'p',
          },
        ],
        'note'
      )
    ).toThrow(MaterialDocumentValidationError);
  });

  it('requires the custom block for the material kind', () => {
    expect(() => assertCanonicalMaterialValue([paragraph(1)], 'quiz')).toThrow(
      'quiz element is required'
    );
  });

  it('rejects duplicate top-level block IDs', () => {
    expect(() =>
      assertCanonicalMaterialValue(
        [paragraph(1), { ...paragraph(2), id: 'block_1' }],
        'note'
      )
    ).toThrow('is duplicated');
  });

  it('does not apply product caps to structural validation', () => {
    const overNodeLimit = Array.from({ length: 10_001 }, (_, index) =>
      paragraph(index)
    );
    expect(() =>
      assertCanonicalMaterialValue(overNodeLimit, 'note')
    ).not.toThrow();
  });
});

describe('embedded material references', () => {
  const ref = (materialId = 'mat_child') => ({
    children: [{ text: '' }],
    id: 'ref_1',
    materialId,
    refKind: 'quiz',
    type: 'material_ref',
  });

  it('rejects inline study blocks inside a note', () => {
    expect(() => assertCanonicalMaterialValue([quiz(10)], 'note')).toThrow(
      'note cannot contain an inline quiz block'
    );
  });

  it('accepts a top-level reference in a note only', () => {
    expect(() =>
      assertCanonicalMaterialValue([paragraph(1), ref()], 'note')
    ).not.toThrow();
    expect(() =>
      assertCanonicalMaterialValue(
        [{ children: [ref()], id: 'block_1', type: 'callout' }],
        'note'
      )
    ).toThrow('must be a top-level block');
    expect(() =>
      assertCanonicalMaterialValue([quiz(10), ref()], 'quiz')
    ).toThrow('quiz cannot contain a material reference');
  });

  it('requires a material id, a study kind and an empty leaf', () => {
    expect(() => assertCanonicalMaterialValue([ref('')], 'note')).toThrow(
      'materialId is required'
    );
    expect(() =>
      assertCanonicalMaterialValue(
        [{ ...ref(''), pending: 'questions: []' }],
        'note'
      )
    ).not.toThrow();
    expect(() =>
      assertCanonicalMaterialValue([{ ...ref(), refKind: 'note' }], 'note')
    ).toThrow('refKind must be quiz or flashcards');
    expect(() =>
      assertCanonicalMaterialValue(
        [{ ...ref(), children: [{ text: 'x' }] }],
        'note'
      )
    ).toThrow('one empty text leaf');
  });
});

describe('interactive HTML blocks', () => {
  const embed = (id: string, html = '<p>x</p>') => ({
    caption: 'Tangent',
    children: [{ text: '' }],
    html,
    id,
    type: HTML_EMBED_TYPE,
  });

  it('caps the snippet size and the blocks per note, like Go', () => {
    const ten = Array.from({ length: HTML_EMBED_MAX_COUNT }, (_, i) =>
      embed(`e${i}`, 'é'.repeat(HTML_EMBED_MAX_BYTES / 2))
    );
    expect(() => assertCanonicalMaterialValue(ten, 'note')).not.toThrow();
    expect(() =>
      assertCanonicalMaterialValue([...ten, embed('e10')], 'note')
    ).toThrow('11 interactive blocks over 10');
    expect(() =>
      assertCanonicalMaterialValue(
        [embed('e0', 'é'.repeat(HTML_EMBED_MAX_BYTES / 2 + 1))],
        'note'
      )
    ).toThrow('over 65536');
    expect(() =>
      assertCanonicalMaterialValue(
        [{ children: [embed('e0')], id: 'c', type: 'callout' }],
        'note'
      )
    ).toThrow('top-level');
    expect(() =>
      assertCanonicalMaterialValue([{ ...embed('e0'), src: 'x' }], 'note')
    ).toThrow('unexpected interactive field src');
  });
});

describe('copied bank figures in a quiz', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withFigure = (url: string) => {
    const value = quiz(0);
    value.children[0].question.stem = [
      {
        description: 'A figure',
        height: 300,
        image: { url },
        type: 'image',
        width: 400,
      },
    ] as never[];
    return [value];
  };

  it('accepts a link under BANK_ASSETS_URL only, like Go', () => {
    const figure = 'https://bank.example/assets/f.png';
    vi.stubEnv('BANK_ASSETS_URL', '');
    expect(() =>
      assertCanonicalMaterialValue(withFigure(figure), 'quiz')
    ).toThrow('bank asset host');
    vi.stubEnv('BANK_ASSETS_URL', 'https://bank.example/assets');
    expect(() =>
      assertCanonicalMaterialValue(withFigure(figure), 'quiz')
    ).not.toThrow();
    for (const outside of [
      'https://bank.example.evil/assets/f.png',
      'https://bank.example/assets/../private/f.png',
      'https://bank.example/assetsx/f.png',
    ])
      expect(() =>
        assertCanonicalMaterialValue(withFigure(outside), 'quiz')
      ).toThrow('bank asset host');
  });
});
