import { ErrorState } from '@/components/app/ErrorState';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { useOnlineStatus } from '@/lib/online';

export function FileLoading({
  message = 'Loading preview...',
}: {
  message?: string;
}) {
  const online = useOnlineStatus();
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      <Spinner className="size-6.5" />
      <p>{online ? message : m.connection_waiting()}</p>
    </div>
  );
}

export function FileError({
  title = m.error_file_title(),
  message = m.error_file_body(),
}: {
  title?: string;
  message?: string;
}) {
  return <ErrorState description={message} title={title} variant="panel" />;
}

export function FileEmpty({
  title = m.error_file_empty_title(),
  message = m.error_file_empty_body(),
}: {
  title?: string;
  message?: string;
}) {
  return <ErrorState description={message} title={title} variant="panel" />;
}
