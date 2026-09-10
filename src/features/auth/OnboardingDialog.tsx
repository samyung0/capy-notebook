import { useUser } from '@clerk/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { qk } from '@/api/client';
import { UpdateMeBody } from '@/api/gen/validators';
import { useMe, useUpdateMe } from '@/api/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { clerkMessage } from './clerk';

const NAME_MAX = UpdateMeBody.shape.name.maxLength ?? 60;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** First-run profile dialog. Opens once per Clerk account, keyed on
 * `unsafeMetadata.onboardedAt`; Confirm and Skip both set it. The avatar goes
 * to Clerk, the name to Capy's own users table. */
export function OnboardingDialog() {
  const { isLoaded, user } = useUser();
  const { data: me } = useMe({ errorBoundary: false });
  const qc = useQueryClient();
  const { mutateAsync: updateMe } = useUpdateMe({ errorToast: false });
  const [dismissed, setDismissed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(
    () => (file ? URL.createObjectURL(file) : undefined),
    [file]
  );
  useEffect(() => {
    if (preview) return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const schema = useMemo(
    () => z.object({ name: z.string().trim().pipe(UpdateMeBody.shape.name) }),
    []
  );
  const {
    control,
    formState: { isValid },
    handleSubmit,
    reset,
  } = useForm({
    defaultValues: { name: '' },
    mode: 'onChange',
    resolver: zodResolver(schema),
  });
  // Prefill once the profile arrives; OAuth accounts carry the provider name.
  useEffect(() => {
    if (me) reset({ name: me.name });
  }, [me, reset]);

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

  const confirm = handleSubmit(async ({ name }) => {
    setBusy(true);
    setFormError(null);
    try {
      if (file) await user.setProfileImage({ file });
      if (name !== me.name) await updateMe({ name });
      await markOnboarded();
      // The gateway refreshes the avatar from Clerk on the next request.
      await qc.invalidateQueries({ queryKey: qk.me });
      setDismissed(true);
    } catch (error) {
      setFormError(
        clerkMessage(error as { message: string; longMessage?: string })
      );
    } finally {
      setBusy(false);
    }
  });

  const pickFile = (picked: File | null) => {
    if (picked && picked.size > IMAGE_MAX_BYTES) {
      setFileError(m.onboarding_image_too_large());
      return;
    }
    setFileError(null);
    setFile(picked);
  };

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
      width={440}
    >
      <p className="t-meta -mt-2 mb-5 text-fg-muted">{m.onboarding_hint()}</p>
      {formError && (
        <p
          className="mb-3 rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
          role="alert"
        >
          {formError}
        </p>
      )}
      <div className="mb-5 flex items-center gap-4">
        <Avatar name={me.name} size={72} src={preview ?? me.avatarUrl} />
        <div>
          <Button
            iconLeft="upload"
            onClick={() => inputRef.current?.click()}
            size="sm"
            type="button"
            variant="outline"
          >
            {m.onboarding_upload()}
          </Button>
          <p className="t-meta mt-1.5 text-fg-muted">
            {m.onboarding_upload_hint()}
          </p>
          {fileError && <InputError errors={[{ message: fileError }]} />}
          <input
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
            ref={inputRef}
            type="file"
          />
        </div>
      </div>
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <InputTitle required>{m.onboarding_name()}</InputTitle>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="nickname"
              maxLength={NAME_MAX}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
    </SimpleDialog>
  );
}
