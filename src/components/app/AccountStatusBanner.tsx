import { Link } from '@tanstack/react-router';
import { isAccountBlockingError } from '@/api/client';
import { useAccountStatus, useMe } from '@/api/hooks';
import { AccountState } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';

function formatDate(iso?: string) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(getLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function blockingCodeFromError(err: unknown): string | null {
  if (!isAccountBlockingError(err)) return null;
  return err.code;
}

/** Lifecycle warnings + full-screen block for locked accounts. */
export function AccountStatusBanner() {
  const { data: statusData, error: statusError } = useAccountStatus({
    errorBoundary: false,
  });
  const { error: meError } = useMe({ errorBoundary: false });

  const blockingCode =
    blockingCodeFromError(statusError) ??
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

  const state = statusData?.state;
  if (
    !state ||
    state === AccountState.active ||
    state === AccountState.suspended ||
    state === AccountState.deleted ||
    state === AccountState.deletion_pending
  ) {
    return null;
  }

  const graceDate = formatDate(statusData?.graceEndsAt);
  const isFrozen = state === AccountState.over_quota_frozen;

  return (
    <div
      className={cn(
        'mb-1 flex flex-wrap items-center justify-between gap-3 rounded-card border px-4 py-3',
        'border-solid-warning/40 bg-tint-warning text-tint-warning-fg'
      )}
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="t-subtitle font-bold">
          {isFrozen
            ? m.account_banner_frozen_title()
            : m.account_banner_grace_title()}
        </p>
        <p className="mt-1 text-sm opacity-90">
          {isFrozen
            ? m.account_banner_frozen_body()
            : graceDate
              ? m.account_banner_grace_body({ date: graceDate })
              : m.account_banner_grace_body_nodate()}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/subscription">{m.account_banner_subscription()}</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/settings">{m.account_banner_settings()}</Link>
        </Button>
      </div>
    </div>
  );
}
