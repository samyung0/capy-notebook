import { describe, expect, it } from 'vitest';
import {
  assertCanonicalMaterialValue,
  MaterialDocumentValidationError,
} from './materialDocument.js';

function paragraph(index: number) {
  return {
    children: [{ text: `paragraph ${index}` }],
    id: `block_${index}`,
    type: 'p',
  };
}

function quiz(timeLimitMin: number) {
  return {
    children: [
      {
        children: [{ children: [{ text: 'True?' }], type: 'quiz_prompt' }],
        correctBoolean: true,
        id: 'question_1',
        level: 'recall',
        questionType: 'boolean',
        type: 'quiz_question',
      },
    ],
    id: 'quiz_1',
    timeLimitMin,
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

  it('accepts only safe quiz time limits from 1 through 180', () => {
    expect(() =>
      assertCanonicalMaterialValue([quiz(180)], 'quiz')
    ).not.toThrow();
    for (const value of [0, 181, Number.MAX_SAFE_INTEGER + 1, 1e100]) {
      expect(() => assertCanonicalMaterialValue([quiz(value)], 'quiz')).toThrow(
        'timeLimitMin must be an integer from 1 to 180'
      );
    }
  });
});
