import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import { defaultGenerateTitle, nextGenerateTitle } from './generateTitle';

describe('generate titles', () => {
  it('numbers the next unused default per kind', () => {
    expect(nextGenerateTitle('quiz', 'Biology', [])).toBe(
      m.generate_default_quiz_name({ n: 1, workspace: 'Biology' })
    );
    expect(
      nextGenerateTitle('quiz', 'Biology', [
        m.generate_default_quiz_name({ n: 1, workspace: 'Biology' }),
        m.generate_default_quiz_name({ n: 2, workspace: 'Biology' }),
      ])
    ).toBe(m.generate_default_quiz_name({ n: 3, workspace: 'Biology' }));
  });

  it('treats existing titles as case-insensitive', () => {
    const first = defaultGenerateTitle('flashcards', 'Chem', 1);
    expect(nextGenerateTitle('flashcards', 'Chem', [first.toUpperCase()])).toBe(
      defaultGenerateTitle('flashcards', 'Chem', 2)
    );
  });
});
