import { ErrorState } from '@/components/app/ErrorState';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';

/** A failed public page's copy. A missing page (404) and a shared material
 * whose stored content a rule refuses (422 `material_content_unreadable`, the
 * app's "could not be loaded") send the reader back; only a loading failure
 * offers a retry, since retrying the others never helps. */
export function failureCopy(status: number) {
  if (status === 404)
    return {
      body: m.error_not_found_page_body(),
      retry: false,
      title: m.error_not_found_page_title(),
    };
  if (status === 422)
    return {
      body: m.material_decode_body(),
      retry: false,
      title: m.material_decode_title(),
    };
  return {
    body: m.summary_error_body(),
    retry: true,
    title: m.summary_error_title(),
  };
}

export function SummaryFailure({ status }: { status: number }) {
  const { body, retry, title } = failureCopy(status);
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
