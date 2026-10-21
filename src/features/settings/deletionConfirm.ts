import { RequestAccountDeletionBody } from '@/api/gen/validators';
import { m } from '@/i18n';

/** What a user with no stored email types instead, in every locale; the
 * server checks the same word (huma_account_lifecycle.go). */
const CONFIRM_WORD = 'delete';

/** What the deletion dialog asks the user to type: the account email, or the
 * word without one (Epo 2026-10-21). Undefined until the account loads. */
export function deletionConfirmation(email: string | undefined) {
  return email === undefined ? undefined : email || CONFIRM_WORD;
}

/** The deletion form's schema; Delete my account is enabled only while it
 * passes. Case is ignored, as on the server; the dialog sends the text
 * trimmed. */
export function deletionConfirmSchema(email: string | undefined) {
  const expected = deletionConfirmation(email);
  return RequestAccountDeletionBody.refine(
    (v) =>
      !!expected &&
      v.confirmEmail.trim().toLowerCase() === expected.toLowerCase(),
    {
      message: email
        ? m.settings_email_mismatch()
        : m.settings_deletion_word_mismatch(),
      path: ['confirmEmail'],
    }
  );
}
