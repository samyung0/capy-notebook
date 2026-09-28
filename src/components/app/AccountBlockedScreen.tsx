import { isAccountBlockingError } from '@/api/client';
import { useMe } from '@/api/hooks';
import { AccountState } from '@/api/types';
import { m } from '@/i18n';

function blockingCodeFromError(err: unknown): string | null {
  if (!isAccountBlockingError(err)) return null;
  return err.code;
}

/** Full-screen block for locked accounts. */
export function AccountBlockedScreen() {
  // A locked account never gets a /me body: the auth middleware answers every
  // route with the lock code, so the error carries it instead.
  const { data: me, error: meError } = useMe({ errorBoundary: false });
  const statusData = me?.account;

  const blockingCode =
    blockingCodeFromError(meError) ??
    (statusData?.state === AccountState.suspended
      ? 'account_suspended'
      : statusData?.state === AccountState.deleted
        ? 'account_deleted'
        : statusData?.state === AccountState.deletion_pending
          ? 'account_deletion_pending'
          : null);

  if (blockingCode) {
    const title =
      blockingCode === 'account_deleted'
        ? m.account_blocked_deleted_title()
        : blockingCode === 'account_deletion_pending'
          ? m.account_blocked_deletion_pending_title()
          : m.account_blocked_suspended_title();
    const body =
      blockingCode === 'account_deleted'
        ? m.account_blocked_deleted_body()
        : blockingCode === 'account_deletion_pending'
          ? m.account_blocked_deletion_pending_body()
          : m.account_blocked_suspended_body();
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-page p-6 text-fg">
        <div className="mx-auto max-w-md text-center">
          <h1 className="t-page-title">{title}</h1>
          <p className="mt-3 text-fg-secondary">{body}</p>
        </div>
      </div>
    );
  }

  return null;
}
