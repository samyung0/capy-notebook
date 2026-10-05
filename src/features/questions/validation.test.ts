import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('copied bank figures in a quiz', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withFigure = (url: string) => ({
    ...exampleQuestion('q'),
    stem: [
      {
        description: 'A figure',
        height: 300,
        image: { url },
        type: 'image' as const,
        width: 400,
      },
    ],
  });

  it('accepts a link under VITE_BANK_ASSETS_URL only, like Go', () => {
    const figure = 'https://bank.example/assets/f.png';
    vi.stubEnv('VITE_BANK_ASSETS_URL', '');
    expect(() => validateQuestion(withFigure(figure))).toThrow();
    vi.stubEnv('VITE_BANK_ASSETS_URL', 'https://bank.example/assets');
    expect(() => validateQuestion(withFigure(figure))).not.toThrow();
    for (const outside of [
      'https://bank.example.evil/assets/f.png',
      'https://bank.example/assets/../private/f.png',
    ])
      expect(() => validateQuestion(withFigure(outside))).toThrow();
  });
});
