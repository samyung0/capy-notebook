import { z } from 'zod';
import { m } from '@/i18n';

/** Clerk enforces the 12 minimum; digit and symbol are our own sign-up rule. */
export const PASSWORD_MIN = 12;
const DIGIT = /\d/;
const SYMBOL = /[^\p{L}\p{N}\s]/u;

export type PasswordIssue = 'short' | 'digit' | 'symbol';

export function passwordIssues(password: string): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < PASSWORD_MIN) issues.push('short');
  if (!DIGIT.test(password)) issues.push('digit');
  if (!SYMBOL.test(password)) issues.push('symbol');
  return issues;
}

const ISSUE_MESSAGE: Record<PasswordIssue, () => string> = {
  digit: () => m.auth_password_needs_digit(),
  short: () => m.auth_password_too_short(),
  symbol: () => m.auth_password_needs_symbol(),
};

/** Sign-in sends the password exactly as typed; spaces are part of it. */
export function signInPasswordSchema() {
  return z.string().min(1, { error: () => m.auth_field_required() });
}

/** Schema for new-password fields (sign-up, reset). Sign-in never uses it. */
export function newPasswordSchema() {
  return z.string().superRefine((value, ctx) => {
    const issue = passwordIssues(value)[0];
    if (issue)
      ctx.addIssue({ code: 'custom', message: ISSUE_MESSAGE[issue]() });
  });
}
