import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Question, QuestionPart } from '@/api/types';
import { type Answer, runScore, scorePart } from './grade';

// The server grades; this scorer stands in for it in the MSW mocks, so it must
// agree with questions.ScorePart on the shared fixtures.
const directory = new URL(
  '../../../server/internal/questions/testdata/scoring/',
  import.meta.url
);

describe('scorePart matches the server on the shared scoring fixtures', () => {
  for (const name of readdirSync(directory).filter((file) =>
    file.endsWith('.json')
  )) {
    const { cases } = JSON.parse(
      readFileSync(new URL(name, directory), 'utf8')
    ) as {
      cases: {
        name: string;
        part: QuestionPart;
        answer?: Answer;
        awarded: number;
        items: boolean[];
      }[];
    };
    for (const fixture of cases)
      it(`${name}: ${fixture.name}`, () => {
        const { awarded, items } = scorePart(fixture.part, fixture.answer);
        expect({ awarded, items }).toEqual({
          awarded: fixture.awarded,
          items: fixture.items,
        });
      });
  }
});

// A checked question counts with the marks it was checked against, an
// unchecked one with its marks now, and one removed since still counts.
it('scores a run as the server does', () => {
  const question = (id: string, marks: number, awarded?: number) =>
    ({
      id,
      parts: [{ awarded, id: `${id}:a`, marks }],
    }) as unknown as Question;
  const quiz = [question('q1', 5), question('q2', 2)];
  const checked = [question('q1', 1, 1), question('gone', 3, 2)];
  expect(runScore(quiz, checked)).toEqual({ awarded: 3, max: 6 });
});
