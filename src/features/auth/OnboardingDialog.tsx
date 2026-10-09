import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { qk } from '@/api/client';
import { UpdateMeBody, updateMeBodyNameMax } from '@/api/gen/validators';
import { useMe, useUpdateMe } from '@/api/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { useUser } from '@/features/auth/clerkHooks';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';
import { textLength } from '@/lib/textLength';
import { clerkMessage } from './clerk';
import { PhotoEditorDialog } from './PhotoEditorDialog';
import { useProfilePhoto } from './useProfilePhoto';

/** First-run profile dialog. Opens once per Clerk account, keyed on
 * `unsafeMetadata.onboardedAt`; Confirm and Skip both set it. Photos go
 * to Clerk; names and curated icon selections stay in Capy. */
export function OnboardingDialog() {
  const { isLoaded, user } = useUser();
  const { data: me } = useMe({ errorBoundary: false });
  const qc = useQueryClient();
  const { mutateAsync: updateMe } = useUpdateMe({ errorToast: false });
  const [dismissed, setDismissed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const photo = useProfilePhoto();
  const { file } = photo;

  const schema = useMemo(
    () =>
      UpdateMeBody.extend({
        name: z.string().trim().pipe(UpdateMeBody.shape.name),
      }),
    []
  );
  const {
    control,
    formState: { isValid },
    handleSubmit,
    reset,
    watch,
  } = useForm({
    defaultValues: { avatarIconId: undefined, name: '' },
    mode: 'onChange',
    resolver: zodResolver(schema),
  });
  const initializedUser = useRef<string | null>(null);
  // A background refresh must not replace the user's pending choice or name.
  useEffect(() => {
    if (me && initializedUser.current !== me.id) {
      initializedUser.current = me.id;
      reset({ avatarIconId: me.avatarIconId, name: me.name });
    }
  }, [me, reset]);
  const avatarIconId = watch('avatarIconId');

  const open =
    isLoaded &&
    !!user &&
    !!me &&
    !dismissed &&
    !user.unsafeMetadata.onboardedAt;
  if (!open) return null;

  const markOnboarded = () =>
    user.updateMetadata({
      unsafeMetadata: { onboardedAt: new Date().toISOString() },
    });

  const skip = async () => {
    setDismissed(true);
    try {
      await markOnboarded();
    } catch {
      // The dialog simply returns on the next visit.
    }
  };

  const confirm = handleSubmit(async ({ name, avatarIconId }) => {
    setBusy(true);
    setFormError(null);
    try {
      if (file) await user.setProfileImage({ file });
      if (name !== me.name || file || avatarIconId !== me.avatarIconId) {
        await updateMe({ avatarIconId: file ? '' : avatarIconId, name });
      }
      await markOnboarded();
      // Refresh profile consumers after both services have saved successfully.
      await qc.invalidateQueries({ queryKey: qk.me });
      setDismissed(true);
    } catch (error) {
      // Clerk's own messages are user-facing; our API's never are.
      setFormError(
        errorCopy(
          error,
          clerkMessage(error as { message: string; longMessage?: string })
        )
      );
    } finally {
      setBusy(false);
    }
  });

  return (
    <SimpleDialog
      footer={
        <>
          <Button
            disabled={busy}
            onClick={() => void skip()}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.onboarding_skip()}
          </Button>
          <Button
            disabled={busy || !isValid}
            size="lg"
            type="submit"
            variant="accent"
          >
            {busy ? <Spinner /> : m.action_confirm()}
          </Button>
        </>
      }
      onClose={() => {
        if (!busy) void skip();
      }}
      onEscapeKeyDown={(event) => busy && event.preventDefault()}
      onInteractOutside={(event) => busy && event.preventDefault()}
      onSubmit={(event) => void confirm(event)}
      open={open}
      showCloseButton={false}
      title={m.onboarding_title()}
    >
      {formError && (
        <p
          className="rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
          role="alert"
        >
          {formError}
        </p>
      )}
      <div>
        <div className="mb-5 flex items-center gap-5">
          <Avatar
            className="size-20"
            name={me.name}
            src={
              photo.preview ??
              (avatarIconId ? iconUrl(avatarIconId) : me.avatarUrl)
            }
          />
          <div className="translate-y-1">
            <div className="flex flex-wrap gap-2">
              <Controller
                control={control}
                name="avatarIconId"
                render={({ field }) => (
                  <IconPicker
                    disabled={busy}
                    onChange={(id) => {
                      field.onChange(id);
                      photo.clear();
                    }}
                    value={field.value}
                  />
                )}
              />
              <Button
                disabled={busy}
                iconLeft="upload"
                onClick={photo.open}
                size="sm"
                type="button"
                variant="outline"
              >
                {m.onboarding_upload()}
              </Button>
            </div>
            <p className="mt-1.5 text-fg-muted">{m.onboarding_upload_hint()}</p>
            <input {...photo.inputProps} disabled={busy} />
            <PhotoEditorDialog {...photo.editor} />
          </div>
        </div>
        {photo.error && <InputError errors={[{ message: photo.error }]} />}
      </div>
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <InputTitle
              count={{
                max: updateMeBodyNameMax,
                value: textLength(field.value),
              }}
              required
            >
              {m.onboarding_name()}
            </InputTitle>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="nickname"
              disabled={busy}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
    </SimpleDialog>
  );
}
