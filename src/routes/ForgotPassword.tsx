import { useSignIn } from '@clerk/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { AuthCard, AuthPage, FormAlert } from '@/features/auth/AuthLanding';
import { clerkMessage } from '@/features/auth/clerk';
import { newPasswordSchema } from '@/features/auth/password';
import { m } from '@/i18n';

const emailSchema = z.object({
  email: z.email({ error: () => m.auth_field_required() }),
});

function Submit({ busy, label }: { busy: boolean; label: string }) {
  return (
    <Button disabled={busy} fullWidth type="submit" variant="accent">
      {busy ? <Spinner /> : label}
    </Button>
  );
}

/** Clerk's reset is code-based: send a code to the email, then verify it and
 * set the new password in one step. The verified reset also signs the user in. */
export default function ForgotPasswordPage() {
  const { signIn } = useSignIn();
  const router = useRouter();
  const id = useId();
  const [email, setEmail] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    control: emailControl,
    formState: { isSubmitting: emailSubmitting },
    handleSubmit: handleEmailSubmit,
  } = useForm({
    defaultValues: { email: '' },
    resolver: zodResolver(emailSchema),
  });
  const resetSchema = useMemo(
    () =>
      z.object({
        code: z
          .string()
          .trim()
          .min(1, { error: () => m.auth_field_required() }),
        password: newPasswordSchema(),
      }),
    []
  );
  const {
    control: resetControl,
    formState: { isSubmitting: resetSubmitting },
    handleSubmit: handleResetSubmit,
  } = useForm({
    defaultValues: { code: '', password: '' },
    mode: 'onBlur',
    resolver: zodResolver(resetSchema),
  });

  if (email === null) {
    return (
      <AuthPage>
        <AuthCard hint={m.auth_reset_hint()} title={m.auth_reset_title()}>
          <a
            className="t-meta mb-4 inline-block text-fg-muted hover:text-fg"
            href="/sign-in"
          >
            ← {m.auth_back_to_signin()}
          </a>
          <form
            onSubmit={handleEmailSubmit(async (values) => {
              setFormError(null);
              const { error } = await signIn.create({
                identifier: values.email,
              });
              if (error) {
                setFormError(clerkMessage(error));
                return;
              }
              const { error: sendError } =
                await signIn.resetPasswordEmailCode.sendCode();
              if (sendError) {
                setFormError(clerkMessage(sendError));
                return;
              }
              setEmail(values.email);
            })}
          >
            <FormAlert message={formError} />
            <Controller
              control={emailControl}
              name="email"
              render={({ field, fieldState }) => (
                <label
                  className="mb-3 flex flex-col gap-1.5"
                  htmlFor={`${id}-email`}
                >
                  <InputTitle>{m.auth_email()}</InputTitle>
                  <Input
                    {...field}
                    aria-invalid={fieldState.invalid}
                    autoComplete="email"
                    autoFocus
                    id={`${id}-email`}
                    type="email"
                  />
                  {fieldState.error && (
                    <InputError errors={[fieldState.error]} />
                  )}
                </label>
              )}
            />
            <Submit busy={emailSubmitting} label={m.auth_reset_submit()} />
          </form>
        </AuthCard>
      </AuthPage>
    );
  }

  return (
    <AuthPage>
      <AuthCard
        hint={m.auth_reset_code_hint({ email })}
        title={m.auth_code_title()}
      >
        <button
          className="t-meta mb-4 inline-block text-fg-muted hover:text-fg"
          onClick={() => {
            setFormError(null);
            setEmail(null);
          }}
          type="button"
        >
          ← {m.auth_code_back()}
        </button>
        <form
          onSubmit={handleResetSubmit(async ({ code, password }) => {
            setFormError(null);
            const { error } = await signIn.resetPasswordEmailCode.verifyCode({
              code,
            });
            if (error) {
              setFormError(clerkMessage(error));
              return;
            }
            const { error: passwordError } =
              await signIn.resetPasswordEmailCode.submitPassword({ password });
            if (passwordError) {
              setFormError(clerkMessage(passwordError));
              return;
            }
            const { error: finalizeError } = await signIn.finalize({
              navigate: async () => router.history.push('/'),
            });
            if (finalizeError) setFormError(clerkMessage(finalizeError));
          })}
        >
          <FormAlert message={formError} />
          <Controller
            control={resetControl}
            name="code"
            render={({ field, fieldState }) => (
              <label
                className="mb-3 flex flex-col gap-1.5"
                htmlFor={`${id}-code`}
              >
                <InputTitle>{m.auth_code()}</InputTitle>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  autoComplete="one-time-code"
                  autoFocus
                  id={`${id}-code`}
                  inputMode="numeric"
                />
                {fieldState.error && <InputError errors={[fieldState.error]} />}
              </label>
            )}
          />
          <Controller
            control={resetControl}
            name="password"
            render={({ field, fieldState }) => (
              <label
                className="mb-3 flex flex-col gap-1.5"
                htmlFor={`${id}-password`}
              >
                <InputTitle>{m.auth_new_password()}</InputTitle>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  autoComplete="new-password"
                  id={`${id}-password`}
                  type="password"
                />
                {fieldState.error ? (
                  <InputError errors={[fieldState.error]} />
                ) : (
                  <span className="t-meta text-fg-muted">
                    {m.auth_password_rule()}
                  </span>
                )}
              </label>
            )}
          />
          <Submit
            busy={resetSubmitting}
            label={m.auth_reset_submit_password()}
          />
        </form>
      </AuthCard>
    </AuthPage>
  );
}
