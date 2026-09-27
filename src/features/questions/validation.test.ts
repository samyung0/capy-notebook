import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exampleQuestion } from './questionFixtures';
import {
  type QuestionPolicy,
  validateQuestion,
  validateQuestions,
} from './validation';

const directory = new URL(
  '../../../server/internal/questions/testdata/',
  import.meta.url
);
describe('shared Go, collaboration and browser question fixtures', () => {
  for (const name of readdirSync(directory).filter((name) =>
    name.endsWith('.json')
  )) {
    const fixture = JSON.parse(
      readFileSync(new URL(name, directory), 'utf8')
    ) as { valid: boolean; question: unknown; policy: QuestionPolicy };
    it(name, () => {
      if (fixture.valid)
        expect(() =>
          validateQuestion(fixture.question, fixture.policy)
        ).not.toThrow();
      else
        expect(() =>
          validateQuestion(fixture.question, fixture.policy)
        ).toThrow();
    });
  }
  it('rejects duplicate part identities across different questions', () => {
    const one = exampleQuestion('one');
    const two = exampleQuestion('two');
    two.parts[0].id = one.parts[0].id;
    expect(() => validateQuestions([one, two])).toThrow('Part IDs');
  });
});
