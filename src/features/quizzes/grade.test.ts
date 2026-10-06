import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuestionPart } from '@/api/types';
import { type Answer, scorePart } from './grade';

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
