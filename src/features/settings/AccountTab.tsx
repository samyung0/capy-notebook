import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { USE_MSW } from '@/api/auth';
import { qk } from '@/api/client';
import { UpdateMeBody } from '@/api/gen/validators';
import { useMe, useUpdateMe } from '@/api/hooks';
import { TabHeader } from '@/components/app/tabPanel';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { clerkMessage } from '@/features/auth/clerk';
import { useUser } from '@/features/auth/clerkHooks';
import { useProfilePhoto } from '@/features/auth/useProfilePhoto';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';

const NAME_MAX = UpdateMeBody.shape.name.maxLength ?? 60;

type ClerkUser = ReturnType<typeof useUser>['user'];

// Clerk hooks throw without a provider; MSW swaps in mock hooks instead.
const CLERK_HOOKS = USE_MSW || !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function AccountTab() {
  return CLERK_HOOKS ? <ClerkAccountTab /> : <AccountForm />;
}

function ClerkAccountTab() {
  const { user } = useUser();
  return <AccountForm user={user} />;
}

/** Profile, saved together: photo to Clerk, name and icon to Capy. Without
 * Clerk there is nowhere to store a photo, so Upload photo is hidden. */
function AccountForm({ user }: { user?: ClerkUser }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { mutateAsync: updateMe } = useUpdateMe({ errorToast: false });
  const photo = useProfilePhoto();
  const [formError, setFormError] = useState<string | null>(null);

  const schema = useMemo(
    () =>
      UpdateMeBody.extend({
        name: z.string().trim().pipe(UpdateMeBody.shape.name),
      }),
    []
  );
  const {
    control,
    formState: { isDirty, isSubmitting, isValid },
    handleSubmit,
    reset,
    watch,
  } = useForm({
    defaultValues: { avatarIconId: undefined, name: '' },
    mode: 'onChange',
    resolver: zodResolver(schema),
  });
  const initializedUser = useRef<string | null>(null);
  // A background refresh must not replace a pending choice or name.
  useEffect(() => {
    if (me && initializedUser.current !== me.id) {
      initializedUser.current = me.id;
      reset({ avatarIconId: me.avatarIconId, name: me.name });
    }
  }, [me, reset]);
  const avatarIconId = watch('avatarIconId');

  const save = handleSubmit(async ({ name, avatarIconId }) => {
    setFormError(null);
    try {
      if (photo.file) await user?.setProfileImage({ file: photo.file });
      await updateMe({ avatarIconId: photo.file ? '' : avatarIconId, name });
      await qc.invalidateQueries({ queryKey: qk.me });
      reset({ avatarIconId: photo.file ? undefined : avatarIconId, name });
      photo.clear();
    } catch (error) {
      setFormError(
        clerkMessage(error as { message: string; longMessage?: string })
      );
    }
  });

  return (
    <>
      <TabHeader
        description={m.settings_account_hint()}
        title={m.settings_account()}
      />
      <form className="flex flex-col gap-8" onSubmit={(e) => void save(e)}>
        {formError && (
          <p
            className="rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
            role="alert"
          >
            {formError}
          </p>
        )}
        <div className="mb-2 flex flex-col gap-1.5">
          <InputTitle>{m.settings_avatar()}</InputTitle>
          <div className="flex items-center gap-5">
            <Avatar
              className="size-14 text-[22.4px]"
              name={me?.name}
              src={
                photo.preview ??
                (avatarIconId ? iconUrl(avatarIconId) : me?.avatarUrl)
              }
            />
            <div className="flex flex-wrap gap-2">
              <Controller
                control={control}
                name="avatarIconId"
                render={({ field }) => (
                  <IconPicker
                    disabled={isSubmitting}
                    onChange={(id) => {
                      field.onChange(id);
                      photo.clear();
                    }}
                    value={field.value}
                  />
                )}
              />
              {user && (
                <>
                  <Button
                    disabled={isSubmitting}
                    iconLeft="upload"
                    onClick={photo.open}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {m.onboarding_upload()}
                  </Button>
                  <input {...photo.inputProps} disabled={isSubmitting} />
                </>
              )}
            </div>
          </div>
          {photo.error && <InputError errors={[{ message: photo.error }]} />}
        </div>
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <label className="flex min-w-0 flex-col gap-1.5">
                <InputTitle required>{m.onboarding_name()}</InputTitle>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  autoComplete="nickname"
                  disabled={isSubmitting}
                  maxLength={NAME_MAX}
                />
                {fieldState.invalid && (
                  <InputError errors={[fieldState.error]} />
                )}
              </label>
            )}
          />
          <label className="flex min-w-0 flex-col gap-1.5">
            <InputTitle>{m.settings_email()}</InputTitle>
            <Input disabled readOnly value={me?.email ?? ''} />
          </label>
        </div>
        <div className="flex justify-end">
          <Button
            disabled={isSubmitting || !isValid || (!isDirty && !photo.file)}
            size="lg"
            type="submit"
            variant="accent"
          >
            {isSubmitting ? <Spinner /> : m.action_save()}
          </Button>
        </div>
      </form>
    </>
  );
}
