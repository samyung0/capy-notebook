import { ErrorState } from '@/components/app/ErrorState';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';
import type { ShareKind } from '@/share/state';

const UNREADABLE_TITLES: Record<ShareKind, () => string> = {
  flashcards: m.share_unreadable_flashcards_title,
  notes: m.share_unreadable_note_title,
  quizzes: m.share_unreadable_quiz_title,
};

/** A failed public page's copy. A missing page (404) and a shared note, quiz
 * or set whose stored content a rule refuses (422
 * `material_content_unreadable`, named by its kind) send the reader back; only
 * a loading failure offers a retry, since retrying the others never helps. */
export function failureCopy(status: number, kind?: ShareKind) {
  if (status === 404)
    return {
      body: m.error_not_found_page_body(),
      retry: false,
      title: m.error_not_found_page_title(),
    };
  if (status === 422 && kind)
    return {
      body: m.share_unreadable_body(),
      retry: false,
      title: UNREADABLE_TITLES[kind](),
    };
  return {
    body: m.summary_error_body(),
    retry: true,
    title: m.summary_error_title(),
  };
}

export function SummaryFailure({
  kind,
  status,
}: {
  kind?: ShareKind;
  status: number;
}) {
  const { body, retry, title } = failureCopy(status, kind);
  return (
    <ErrorState
      action={
        <ErrorAction asChild back={!retry}>
          <a href={retry ? '' : '/'}>
            {retry ? m.summary_retry() : m.error_action_go_back()}
          </a>
        </ErrorAction>
      }
      className="h-auto flex-1 py-12"
      description={body}
      title={title}
      variant="page"
    />
  );
}
