import { isApiError } from '@/api/client';
import { PublicPage } from '@/components/app/PublicHeader';
import { getLocale } from '@/i18n';
import { SummaryFailure } from '@/summary/SummaryFailure';

/** 404 for a missing, private or unshared item (the Worker answers forged
 * links the same way before any script runs); 503 for anything else. */
export const failureStatus = (error: unknown) =>
  isApiError(error) && error.status === 404 ? 404 : 503;

/** The workspace summary's failure page: not found is a bare panel with no
 * header, unavailable keeps the header and offers a retry. */
export function ShareError({ status }: { status: 404 | 503 }) {
  const failure = <SummaryFailure locale={getLocale()} status={status} />;
  if (status !== 404) return <PublicPage>{failure}</PublicPage>;
  return (
    <div className="t-body flex min-h-dvh flex-col bg-page p-2.5 text-fg">
      <main className="flex flex-1 rounded-card-xl bg-surface shadow-card">
        {failure}
      </main>
    </div>
  );
}
