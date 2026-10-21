import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { deletionConfirmation, deletionConfirmSchema } from './deletionConfirm';

const typed = (confirmEmail: string) => ({
  confirmEmail,
  lifecycleGeneration: 0,
});

// Epo 2026-10-21: an account with no stored email confirms deletion by typing
// "delete"; an account with an email types the email, never the word. The
// dialog enables Delete my account only while this schema passes.
it('enables deletion with the word only for an account with no email', () => {
  expect(deletionConfirmation('')).toBe('delete');
  const noEmail = deletionConfirmSchema('');
  expect(noEmail.safeParse(typed('delete')).success).toBe(true);
  expect(noEmail.safeParse(typed(' Delete ')).success).toBe(true);
  const wrong = noEmail.safeParse(typed('remove'));
  expect(wrong.success).toBe(false);
  expect(wrong.error?.issues[0]?.message).toBe(
    m.settings_deletion_word_mismatch()
  );

  expect(deletionConfirmation('kate@example.test')).toBe('kate@example.test');
  const withEmail = deletionConfirmSchema('kate@example.test');
  expect(withEmail.safeParse(typed('delete')).success).toBe(false);
  expect(withEmail.safeParse(typed('Kate@example.test')).success).toBe(true);

  // Before the account loads nothing confirms.
  expect(
    deletionConfirmSchema(undefined).safeParse(typed('delete')).success
  ).toBe(false);
});
