import { describe, expect, it } from 'vitest';
import { passwordIssues, signInPasswordSchema } from './password';

describe('passwordIssues', () => {
  it('accepts 12+ characters with a digit and a symbol', () => {
    expect(passwordIssues('capybara-2026!')).toEqual([]);
    expect(passwordIssues('水豚水豚水豚水豚水豚水1！')).toEqual([]);
  });
  it('names every missing rule', () => {
    expect(passwordIssues('short1!')).toEqual(['short']);
    expect(passwordIssues('longenoughpassword')).toEqual(['digit', 'symbol']);
    expect(passwordIssues('longenoughpassword1')).toEqual(['symbol']);
    expect(passwordIssues('long enough pass!')).toEqual(['digit']);
  });
});

describe('signInPasswordSchema', () => {
  it('keeps surrounding spaces so the value sent to Clerk is the typed one', () => {
    expect(signInPasswordSchema().parse(' capybara-2026! ')).toBe(
      ' capybara-2026! '
    );
    expect(signInPasswordSchema().safeParse('').success).toBe(false);
  });
});
