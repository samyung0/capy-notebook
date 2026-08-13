import { describe, expect, it } from 'vitest';
import { m } from '@/i18n';
import {
  defaultGenerateTitle,
  GENERATE_TITLE_MAX,
  nextGenerateTitle,
  validateGenerateTitle,
} from './generateTitle';

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

  it('rejects empty, overlong, and taken names', () => {
    expect(validateGenerateTitle('  ', [])).toBe(m.generate_name_required());
    expect(validateGenerateTitle('a'.repeat(GENERATE_TITLE_MAX + 1), [])).toBe(
      m.generate_name_too_long({ max: GENERATE_TITLE_MAX })
    );
    expect(validateGenerateTitle('Cell quiz', ['cell quiz'])).toBe(
      m.generate_name_taken()
    );
    expect(validateGenerateTitle('  Cell quiz  ', ['Other'])).toBeNull();
  });
});
