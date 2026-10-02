import { api } from '@/api/client';
import type { ComputationCheckResp, Question } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** Warns the author when Jev judges a saved open part computational: its
 * answers would need a calculation checked, which Jev grades unreliably. The
 * check is advisory, so a failed request is not reported. */
export async function warnComputationalOpenParts(question: Question) {
  const open = question.parts.filter((part) => part.answer.type === 'open');
  if (!open.length) return;
  try {
    const results = await Promise.all(
      open.map((part) =>
        api.post<ComputationCheckResp>('/questions/computation-check', {
          partId: part.id,
          question,
        })
      )
    );
    if (results.some((result) => result.computational))
      userToast({
        description: m.question_computation_warning_body(),
        title: m.question_computation_warning_title(),
        variant: 'warning',
      });
  } catch {
    // Saving already succeeded; the warning is only advice.
  }
}
