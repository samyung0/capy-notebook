import { ErrorState } from '@/components/app/ErrorState';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';

export function SummaryFailure({ status }: { status: number }) {
  const unavailable = status === 404;
  return (
    <ErrorState
      action={
        <ErrorAction
          asChild
          iconLeft={unavailable ? 'navigationBack' : 'refresh'}
          iconLeftClassName="me-1"
        >
          <a href={unavailable ? '/' : ''}>
            {unavailable ? m.error_action_go_back() : m.summary_retry()}
          </a>
        </ErrorAction>
      }
      className="h-auto flex-1 py-12"
      description={
        unavailable ? m.error_not_found_page_body() : m.summary_error_body()
      }
      title={
        unavailable ? m.error_not_found_page_title() : m.summary_error_title()
      }
      variant="page"
    />
  );
}
