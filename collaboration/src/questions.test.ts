import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertCanonicalMaterialValue } from './materialDocument.js';
import {
  type QuestionPolicy,
  validateQuestion,
  validateQuestions,
} from './questions.js';

const directory = fileURLToPath(
  new URL('../../server/internal/questions/testdata/', import.meta.url)
);
describe('shared question contract', () => {
  it('accepts chart and graph note embeds only at the top level', () => {
    const fixture = JSON.parse(
      readFileSync(`${directory}/rich-blocks.json`, 'utf8')
    ) as { question: { stem: Record<string, unknown>[] } };
    const graph = {
      block: fixture.question.stem[1],
      children: [{ text: '' }],
      id: 'graph1',
      type: 'graph',
    };
    expect(() => assertCanonicalMaterialValue([graph], 'note')).not.toThrow();
    expect(() =>
      assertCanonicalMaterialValue(
        [{ children: [graph], id: 'container', type: 'callout' }],
        'note'
      )
    ).toThrow('top-level');
  });
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith('.json')
  )) {
    const fixture = JSON.parse(
      readFileSync(`${directory}/${file}`, 'utf8')
    ) as {
      name: string;
      valid: boolean;
      policy: QuestionPolicy;
      question: unknown;
    };
    it(fixture.name, () => {
      const check = () => validateQuestion(fixture.question, fixture.policy);
      if (fixture.valid) expect(check).not.toThrow();
      else expect(check).toThrow();
    });
  }
  it('requires distinct part IDs across questions', () => {
    const fixture = JSON.parse(
      readFileSync(`${directory}/short.json`, 'utf8')
    ) as { question: Record<string, unknown> };
    expect(() =>
      validateQuestions([
        fixture.question,
        { ...fixture.question, id: 'other' },
      ])
    ).toThrow('Part IDs');
  });
});
