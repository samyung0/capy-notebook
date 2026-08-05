import { useClerk } from '@clerk/react';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { isApiError } from '@/api/client';
import {
  useDeletionPreflight,
  useMe,
  useNotificationPrefs,
  useRequestAccountDeletion,
  useSetLocale,
  useSetNotificationPrefs,
} from '@/api/hooks';
import { LocaleSwitcher } from '@/components/app/LocaleSwitcher';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { userToast } from '@/components/ui/userToast';
import { getLocale, m, setLocale as setParaglideLocale } from '@/i18n';
import { cn } from '@/lib/cn';
import { STYLES, useTheme } from '@/theme/ThemeProvider';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-divider border-b py-4 last:border-0">
      <p className="t-subtitle">{label}</p>
      {children}
    </div>
  );
}

function AccountDangerZoneInner({
  signOut,
}: {
  signOut?: () => Promise<unknown>;
}) {
  const me = useMe();
  const preflight = useDeletionPreflight();
  const requestDeletion = useRequestAccountDeletion();
  const [confirmEmail, setConfirmEmail] = useState('');

  const emailMatches =
    !!me.data?.email &&
    confirmEmail.trim().toLowerCase() === me.data.email.toLowerCase();
  const canDelete = preflight.data?.canDelete === true && emailMatches;

  async function onRequestDeletion() {
    try {
      await requestDeletion.mutateAsync(confirmEmail.trim());
      setConfirmEmail('');
      userToast({
        title: m.settings_deletion_requested_toast(),
        variant: 'success',
      });
      // Sessions are revoked server-side; sign out locally so the next paint
      // does not keep probing APIs that now return account_deletion_pending.
      if (signOut) await signOut();
    } catch (err) {
      userToast({
        description: isApiError(err)
          ? (err.body?.message ?? err.message)
          : err instanceof Error
            ? err.message
            : undefined,
        title: m.settings_deletion_request_failed(),
        variant: 'error',
      });
    }
  }

  const needingTransfer = preflight.data?.workspacesNeedingTransfer ?? [];
  const toDestroy = preflight.data?.workspacesToDestroy ?? [];
  const subscription = preflight.data?.subscription;

  return (
    <div className="rounded-card border border-solid-error/30 bg-surface px-5 py-4">
      <p className="t-subtitle font-bold text-solid-error">
        {m.settings_danger_zone_title()}
      </p>
      <p className="mt-2 text-fg-secondary text-sm">
        {m.settings_danger_zone_body({
          days: String(preflight.data?.graceDays ?? 30),
        })}
      </p>

      {preflight.isSuccess && (
        <div className="mt-4 space-y-3 text-sm">
          {subscription && (
            <div className="rounded-button border border-solid-error/30 bg-tint-error px-3 py-2.5 text-tint-error-fg">
              {subscription.unavailable
                ? m.settings_deletion_blocker_subscription_unavailable()
                : m.settings_deletion_blocker_subscription()}
            </div>
          )}
          {needingTransfer.length > 0 && (
            <div>
              <p className="font-medium text-fg">
                {m.settings_deletion_needs_transfer()}
              </p>
              <ul className="mt-1 list-disc pl-5 text-fg-secondary">
                {needingTransfer.map((ws) => (
                  <li key={ws.id}>{ws.name}</li>
                ))}
              </ul>
            </div>
          )}
          {toDestroy.length > 0 && (
            <div>
              <p className="font-medium text-fg">
                {m.settings_deletion_will_destroy()}
              </p>
              <ul className="mt-1 list-disc pl-5 text-fg-secondary">
                {toDestroy.map((ws) => (
                  <li key={ws.id}>{ws.name}</li>
                ))}
              </ul>
            </div>
          )}
          {!subscription &&
            needingTransfer.length === 0 &&
            toDestroy.length === 0 && (
              <p className="text-fg-muted">
                {m.settings_deletion_no_side_effects()}
              </p>
            )}
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-fg-secondary text-sm">
          {m.settings_deletion_confirm_email({
            email: me.data?.email ?? '…',
          })}
        </p>
        <Input
          autoComplete="off"
          disabled={requestDeletion.isPending || !preflight.data?.canDelete}
          onChange={(e) => setConfirmEmail(e.target.value)}
          placeholder={me.data?.email}
          value={confirmEmail}
        />
      </div>

      <Button
        className="mt-4"
        disabled={!canDelete || requestDeletion.isPending}
        onClick={() => void onRequestDeletion()}
        size="sm"
        variant="danger"
      >
        {requestDeletion.isPending
          ? m.common_loading()
          : m.settings_deletion_request()}
      </Button>
    </div>
  );
}

function ClerkAccountDangerZone() {
  const { signOut } = useClerk();
  return <AccountDangerZoneInner signOut={() => signOut()} />;
}

function AccountDangerZone() {
  if (!CLERK_ACTIVE) return <AccountDangerZoneInner />;
  return <ClerkAccountDangerZone />;
}

export default function Settings() {
  const { style, setStyle } = useTheme();
  const prefs = useNotificationPrefs();
  const setPrefs = useSetNotificationPrefs();
  const setLocale = useSetLocale();
  const currentPrefs = prefs.data;

  return (
    <Panel>
      <PageHeader showTopBar={false} title={m.profile_menu_settings()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          <p className="t-label mb-1 block text-fg-muted">
            {m.settings_appearance()}
          </p>
          <div className="rounded-card border border-line bg-surface px-5">
            <Row label={m.settings_theme()}>
              <div className="flex gap-1 rounded-full border border-line p-0.75">
                {STYLES.map((t) => (
                  <button
                    className={cn(
                      'rounded-full px-3 py-1.5 font-semibold text-sm',
                      style === t.value
                        ? 'bg-action text-action-fg'
                        : 'text-fg-muted'
                    )}
                    key={t.value}
                    onClick={() => setStyle(t.value)}
                    type="button"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={m.settings_language()}>
              <LocaleSwitcher
                disabled={setLocale.isPending}
                onChange={(locale, previousLocale) => {
                  if (locale !== 'en' && locale !== 'zh') return;
                  void setLocale.mutateAsync(locale).catch(() => {
                    if (getLocale() === locale) {
                      setParaglideLocale(previousLocale as never);
                    }
                  });
                }}
              />
            </Row>
          </div>

          <p className="t-label mt-6 mb-1 text-fg-muted">
            {m.settings_notifications()}
          </p>
          <div className="rounded-card border border-line bg-surface px-5">
            <Row label={m.settings_email_workspace_invite()}>
              <Switch
                aria-label={m.settings_email_workspace_invite()}
                checked={currentPrefs?.emailWorkspaceInvite ?? false}
                disabled={!prefs.isSuccess || setPrefs.isPending}
                onChange={(emailWorkspaceInvite) => {
                  if (!currentPrefs || setPrefs.isPending) return;
                  setPrefs.mutate({ ...currentPrefs, emailWorkspaceInvite });
                }}
              />
            </Row>
            <Row label={m.settings_email_membership()}>
              <Switch
                aria-label={m.settings_email_membership()}
                checked={currentPrefs?.emailMembership ?? false}
                disabled={!prefs.isSuccess || setPrefs.isPending}
                onChange={(emailMembership) => {
                  if (!currentPrefs || setPrefs.isPending) return;
                  setPrefs.mutate({ ...currentPrefs, emailMembership });
                }}
              />
            </Row>
            <Row label={m.settings_email_billing()}>
              <Switch
                aria-label={m.settings_email_billing()}
                checked={currentPrefs?.emailBilling ?? false}
                disabled={!prefs.isSuccess || setPrefs.isPending}
                onChange={(emailBilling) => {
                  if (!currentPrefs || setPrefs.isPending) return;
                  setPrefs.mutate({ ...currentPrefs, emailBilling });
                }}
              />
            </Row>
          </div>

          <p className="t-label mt-6 mb-1 text-fg-muted">
            {m.settings_account()}
          </p>
          <AccountDangerZone />
        </div>
      </div>
    </Panel>
  );
}
