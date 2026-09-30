import { ErrorState } from '@/components/app/ErrorState';
import { ErrorAction } from '@/components/ui/Button';
import { m } from '@/i18n';

export function SummaryFailure({
  status,
  locale,
}: {
  status: number;
  locale: 'en' | 'zh';
}) {
  const options = { locale };
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
            {unavailable
              ? m.error_action_go_back({}, options)
              : m.summary_retry({}, options)}
          </a>
        </ErrorAction>
      }
      className="h-auto flex-1 py-12"
      description={
        unavailable
          ? m.error_not_found_page_body({}, options)
          : m.summary_error_body({}, options)
      }
      title={
        unavailable
          ? m.error_not_found_page_title({}, options)
          : m.summary_error_title({}, options)
      }
      variant="page"
    />
  );
}
