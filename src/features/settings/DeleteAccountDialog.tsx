import { useClerk } from '@clerk/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { USE_MSW } from '@/api/auth';
import { RequestAccountDeletionBody } from '@/api/gen/validators';
import {
  useDeletionPreflight,
  useMe,
  useRequestAccountDeletion,
} from '@/api/hooks';
import type { RequestAccountDeletionReq } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

type Props = { open: boolean; onClose: () => void };

/** Email-confirmed account deletion. The preflight lists what goes with it
 * and blocks while a subscription is still live. */
export function DeleteAccountDialog(props: Props) {
  if (!CLERK_ACTIVE) return <DeleteAccountDialogInner {...props} />;
  return <ClerkDeleteAccountDialog {...props} />;
}

function ClerkDeleteAccountDialog(props: Props) {
  const { signOut } = useClerk();
  return <DeleteAccountDialogInner {...props} signOut={() => signOut()} />;
}

function DeleteAccountDialogInner({
  open,
  onClose,
  signOut,
}: Props & { signOut?: () => Promise<unknown> }) {
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
    handleSubmit,
    control,
    reset,
  } = useForm<RequestAccountDeletionReq>({
    defaultValues: { confirmEmail: '', lifecycleGeneration: 0 },
    mode: 'onChange',
    resolver: zodResolver(deletionSchema),
  });

  const canDelete =
    preflightData?.canDelete === true && isValid && !isSubmitting;

  const submit = handleSubmit(async (v) => {
    if (!preflightData) return;
    try {
      await requestDeletion({
        confirmEmail: v.confirmEmail.trim(),
        lifecycleGeneration: preflightData.lifecycleGeneration,
      });
    } catch {
      // The global mutation handler shows the normalized failure.
      return;
    }
    reset({ confirmEmail: '', lifecycleGeneration: 0 });
    onClose();
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
  });

  const toDestroy = preflightData?.workspacesToDestroy ?? [];
  const subscription = preflightData?.subscription;

  return (
    <SimpleDialog
      footer={
        <>
          <Button
            disabled={isSubmitting}
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            disabled={!canDelete}
            size="lg"
            type="submit"
            variant="danger"
          >
            {isSubmitting ? <Spinner /> : m.settings_deletion_request()}
          </Button>
        </>
      }
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      onSubmit={(event) => void submit(event)}
      open={open}
      title={m.settings_danger_zone_title()}
    >
      <p className="text-fg-secondary">
        {m.settings_danger_zone_body({
          days: String(preflightData?.graceDays ?? 30),
        })}
      </p>
      {preflightIsSuccess && (
        <div className="flex flex-col gap-3 text-sm">
          {subscription && (
            <p className="rounded-button bg-tint-error px-3 py-2.5 text-tint-error-fg">
              {subscription.unavailable
                ? m.settings_deletion_blocker_subscription_unavailable()
                : m.settings_deletion_blocker_subscription()}
            </p>
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
          {!subscription && toDestroy.length === 0 && (
            <p className="text-fg-muted">
              {m.settings_deletion_no_side_effects()}
            </p>
          )}
        </div>
      )}
      <Controller
        control={control}
        name="confirmEmail"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <span className="text-fg-secondary text-sm">
              {m.settings_deletion_confirm_email({
                email: meData?.email ?? '…',
              })}
            </span>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="off"
              disabled={isSubmitting || !preflightData?.canDelete}
              placeholder={meData?.email}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
    </SimpleDialog>
  );
}
