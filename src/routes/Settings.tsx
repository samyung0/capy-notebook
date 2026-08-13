import { useClerk } from '@clerk/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { USE_MSW } from '@/api/auth';
import { RequestAccountDeletionBody } from '@/api/gen/validators';
import {
  useDeletionPreflight,
  useMe,
  useNotificationPrefs,
  useRequestAccountDeletion,
  useSetLocale,
  useSetNotificationPrefs,
} from '@/api/hooks';
import type { RequestAccountDeletionReq } from '@/api/types';
import { LocaleSwitcher } from '@/components/app/LocaleSwitcher';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { Input, InputError } from '@/components/ui/Input';
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
  const { data: meData } = useMe();
  const { data: preflightData, isSuccess: preflightIsSuccess } =
    useDeletionPreflight();
  const { mutateAsync: requestDeletion } = useRequestAccountDeletion();

  const deletionSchema = useMemo(
    () =>
      RequestAccountDeletionBody.refine(
        (v) =>
          !!meData?.email &&
          v.confirmEmail.trim().toLowerCase() === meData.email.toLowerCase(),
        {
          message: m.settings_email_mismatch(),
          path: ['confirmEmail'],
        }
      ),
    [meData?.email]
  );

  const {
    formState: { isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
    reset,
  } = useForm<RequestAccountDeletionReq>({
    defaultValues: { confirmEmail: '' },
    mode: 'onChange',
    resolver: zodResolver(deletionSchema),
  });

  const canDelete =
    preflightData?.canDelete === true && isValid && !isSubmitting;

  async function onRequestDeletion(v: RequestAccountDeletionReq) {
    try {
      await requestDeletion(v.confirmEmail.trim());
    } catch {
      // The global mutation handler shows the normalized failure.
      return;
    }
    reset({ confirmEmail: '' });
    userToast({
      title: m.settings_deletion_requested_toast(),
      variant: 'success',
    });
    // Sessions are revoked server-side; sign out locally so the next paint
    // does not keep probing APIs that now return account_deletion_pending.
    if (signOut) {
      try {
        await signOut();
      } catch {
        userToast({
          description: m.error_generic_body(),
          title: m.settings_deletion_requested_toast(),
          variant: 'warning',
        });
      }
    }
  }

  const needingTransfer = preflightData?.workspacesNeedingTransfer ?? [];
  const toDestroy = preflightData?.workspacesToDestroy ?? [];
  const subscription = preflightData?.subscription;

  return (
    <div className="rounded-card border border-solid-error/30 bg-surface px-5 py-4">
      <p className="t-subtitle font-bold text-solid-error">
        {m.settings_danger_zone_title()}
      </p>
      <p className="mt-2 text-fg-secondary text-sm">
        {m.settings_danger_zone_body({
          days: String(preflightData?.graceDays ?? 30),
        })}
      </p>

      {preflightIsSuccess && (
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

      <form className="mt-4" onSubmit={formSubmit(onRequestDeletion)}>
        <p className="mb-2 text-fg-secondary text-sm">
          {m.settings_deletion_confirm_email({
            email: meData?.email ?? '…',
          })}
        </p>
        <Controller
          control={control}
          name="confirmEmail"
          render={({ field, fieldState }) => (
            <>
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="off"
                disabled={isSubmitting || !preflightData?.canDelete}
                placeholder={meData?.email}
              />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </>
          )}
        />

        <Button
          className="mt-4"
          disabled={!canDelete}
          size="sm"
          type="submit"
          variant="danger"
        >
          {isSubmitting ? m.common_loading() : m.settings_deletion_request()}
        </Button>
      </form>
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
  const { data: prefsData, isSuccess: prefsIsSuccess } = useNotificationPrefs();
  const { isPending: setPrefsIsPending, mutate: setPrefs } =
    useSetNotificationPrefs();
  const { isPending: setLocaleIsPending, mutateAsync: setLocale } =
    useSetLocale();
  const currentPrefs = prefsData;

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
                    {t.value === 'classroom'
                      ? m.theme_style_classroom()
                      : m.theme_style_notion()}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={m.settings_language()}>
              <LocaleSwitcher
                disabled={setLocaleIsPending}
                onChange={(locale, previousLocale) => {
                  if (locale !== 'en' && locale !== 'zh') return;
                  void setLocale(locale).catch(() => {
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
                disabled={!prefsIsSuccess || setPrefsIsPending}
                onCheckedChange={(emailWorkspaceInvite) => {
                  if (!currentPrefs || setPrefsIsPending) return;
                  setPrefs({ ...currentPrefs, emailWorkspaceInvite });
                }}
              />
            </Row>
            <Row label={m.settings_email_membership()}>
              <Switch
                aria-label={m.settings_email_membership()}
                checked={currentPrefs?.emailMembership ?? false}
                disabled={!prefsIsSuccess || setPrefsIsPending}
                onCheckedChange={(emailMembership) => {
                  if (!currentPrefs || setPrefsIsPending) return;
                  setPrefs({ ...currentPrefs, emailMembership });
                }}
              />
            </Row>
            <Row label={m.settings_email_billing()}>
              <Switch
                aria-label={m.settings_email_billing()}
                checked={currentPrefs?.emailBilling ?? false}
                disabled={!prefsIsSuccess || setPrefsIsPending}
                onCheckedChange={(emailBilling) => {
                  if (!currentPrefs || setPrefsIsPending) return;
                  setPrefs({ ...currentPrefs, emailBilling });
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
