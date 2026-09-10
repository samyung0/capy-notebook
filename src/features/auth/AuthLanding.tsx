import { useAuth, useSignIn, useSignUp } from '@clerk/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { LogoMark } from '@/components/ui/Logo';
import { m } from '@/i18n';
import { clerkMessage, redirectAfterAuth, ssoUrls } from './clerk';
import { GoogleIcon, MicrosoftIcon } from './ProviderIcons';
import { newPasswordSchema, signInPasswordSchema } from './password';

type Mode = 'signIn' | 'signUp';

/** Keeps `redirect_url` while hopping between the auth pages. */
function authHref(path: string) {
  return `${path}${window.location.search}`;
}

export function AuthPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-page text-fg">
      <div className="mx-auto grid min-h-dvh max-w-6xl lg:grid-cols-[1.15fr_1fr]">
        <BrandColumn />
        <div className="flex items-center justify-center px-5 pb-10 lg:justify-end lg:px-8 lg:py-10">
          {children}
        </div>
      </div>
    </div>
  );
}

function BrandColumn() {
  return (
    <div className="flex flex-col justify-between gap-10 px-6 pt-8 pb-4 lg:px-12 lg:py-12">
      <div>
        <a className="flex items-center gap-2.5 font-bold" href="/sign-in">
          <LogoMark />
          {m.app_name()}
        </a>
        <h1 className="t-display mt-10 max-w-[18ch] text-balance lg:mt-14">
          {m.auth_brand_headline_a()}{' '}
          <em className="rounded-button bg-solid-success/70 px-2 text-fg not-italic">
            {m.auth_brand_headline_em()}
          </em>
          {m.auth_brand_headline_b()}
        </h1>
        <p className="mt-4 max-w-[46ch] text-base text-fg-secondary">
          {m.auth_brand_lead()}
        </p>
        <ul className="mt-6 flex flex-wrap gap-2">
          {[
            m.auth_pill_quizzes(),
            m.auth_pill_flashcards(),
            m.auth_pill_shared(),
            m.auth_pill_chat(),
          ].map((label) => (
            <li
              className="rounded-full border border-line bg-surface px-3 py-1.5 font-semibold text-fg-secondary text-sm"
              key={label}
            >
              {label}
            </li>
          ))}
        </ul>
      </div>
      <p className="hidden text-fg-muted text-xs lg:block">{m.auth_legal()}</p>
    </div>
  );
}

export function AuthCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      border="solid"
      className="w-full max-w-[400px] gap-0 p-7"
      radius="card-lg"
    >
      <h2 className="t-large-card-title">{title}</h2>
      {hint && <p className="t-meta mt-1 text-fg-muted">{hint}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="mb-3 rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
      role="alert"
    >
      {message}
    </p>
  );
}

function OAuthButtons({ onError }: { onError: (message: string) => void }) {
  const { signIn } = useSignIn();
  const target = redirectAfterAuth();
  const start = async (strategy: 'oauth_google' | 'oauth_microsoft') => {
    const { error } = await signIn.sso({ strategy, ...ssoUrls(target) });
    if (error) onError(clerkMessage(error));
  };
  return (
    <div className="flex flex-col gap-2">
      <Button
        fullWidth
        onClick={() => void start('oauth_google')}
        type="button"
        variant="outline"
      >
        <GoogleIcon />
        {m.auth_google()}
      </Button>
      <Button
        fullWidth
        onClick={() => void start('oauth_microsoft')}
        type="button"
        variant="outline"
      >
        <MicrosoftIcon />
        {m.auth_microsoft()}
      </Button>
      <p className="t-label my-2 flex items-center gap-3 text-fg-muted uppercase before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        {m.auth_or()}
      </p>
    </div>
  );
}

function SubmitButton({
  busy,
  children,
}: {
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button disabled={busy} fullWidth type="submit" variant="accent">
      {busy ? <Spinner /> : children}
    </Button>
  );
}

function Field({
  id,
  label,
  trailing,
  children,
  error,
}: {
  id: string;
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
  error?: { message?: string };
}) {
  return (
    <label className="mb-3 flex flex-col gap-1.5" htmlFor={id}>
      <span className="flex items-baseline justify-between">
        <InputTitle>{label}</InputTitle>
        {trailing}
      </span>
      {children}
      {error && <InputError errors={[error]} />}
    </label>
  );
}

const emailField = z.email({ error: () => m.auth_field_required() });
const requiredField = z
  .string()
  .trim()
  .min(1, {
    error: () => m.auth_field_required(),
  });

/** New-password form, shared by the breached-password step and the reset page. */
export function NewPasswordForm({
  hint,
  submitLabel,
  onSubmit,
}: {
  hint?: string;
  submitLabel: string;
  onSubmit: (password: string) => Promise<string | null>;
}) {
  const schema = useMemo(() => z.object({ password: newPasswordSchema() }), []);
  const {
    control,
    formState: { isSubmitting },
    handleSubmit,
  } = useForm({
    defaultValues: { password: '' },
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();
  return (
    <form
      onSubmit={handleSubmit(async ({ password }) => {
        setFormError(await onSubmit(password));
      })}
    >
      {hint && <p className="t-meta mb-4 text-fg-secondary">{hint}</p>}
      <FormAlert message={formError} />
      <Controller
        control={control}
        name="password"
        render={({ field, fieldState }) => (
          <Field error={fieldState.error} id={id} label={m.auth_new_password()}>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="new-password"
              autoFocus
              id={id}
              type="password"
            />
            {!fieldState.error && (
              <span className="t-meta text-fg-muted">
                {m.auth_password_rule()}
              </span>
            )}
          </Field>
        )}
      />
      <SubmitButton busy={isSubmitting}>{submitLabel}</SubmitButton>
    </form>
  );
}

function SignInCard() {
  const { signIn } = useSignIn();
  const router = useRouter();
  const target = redirectAfterAuth();
  const [step, setStep] = useState<'form' | 'newPassword'>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();
  const schema = useMemo(
    () => z.object({ email: emailField, password: signInPasswordSchema() }),
    []
  );
  const {
    control,
    formState: { isSubmitting },
    handleSubmit,
  } = useForm({
    defaultValues: { email: '', password: '' },
    resolver: zodResolver(schema),
  });
  const finish = async () => {
    const { error } = await signIn.finalize({
      navigate: async () => router.history.push(target),
    });
    return error ? clerkMessage(error) : null;
  };

  if (step === 'newPassword') {
    return (
      <AuthCard title={m.auth_new_password_title()}>
        <NewPasswordForm
          hint={m.auth_new_password_breach_hint()}
          onSubmit={async (password) => {
            const { error } =
              await signIn.resetPasswordEmailCode.submitPassword({ password });
            if (error) return clerkMessage(error);
            return finish();
          }}
          submitLabel={m.auth_new_password_submit()}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard hint={m.auth_signin_hint()} title={m.auth_signin_title()}>
      <OAuthButtons onError={setFormError} />
      <form
        onSubmit={handleSubmit(async ({ email, password }) => {
          setFormError(null);
          const { error } = await signIn.password({
            identifier: email,
            password,
          });
          if (error) {
            setFormError(clerkMessage(error));
            return;
          }
          if (signIn.status === 'needs_new_password') {
            setStep('newPassword');
            return;
          }
          setFormError(await finish());
        })}
      >
        <FormAlert message={formError} />
        <Controller
          control={control}
          name="email"
          render={({ field, fieldState }) => (
            <Field
              error={fieldState.error}
              id={`${id}-email`}
              label={m.auth_email()}
            >
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="email"
                autoFocus
                id={`${id}-email`}
                type="email"
              />
            </Field>
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <Field
              error={fieldState.error}
              id={`${id}-password`}
              label={m.auth_password()}
              trailing={
                <a
                  className="font-semibold text-link text-sm hover:text-link-hover"
                  href={authHref('/forgot-password')}
                >
                  {m.auth_forgot()}
                </a>
              }
            >
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="current-password"
                id={`${id}-password`}
                type="password"
              />
            </Field>
          )}
        />
        <SubmitButton busy={isSubmitting}>{m.action_sign_in()}</SubmitButton>
      </form>
      <p className="mt-4 text-center text-fg-secondary text-sm">
        {m.auth_new_here()}{' '}
        <a
          className="font-semibold text-link hover:text-link-hover"
          href={authHref('/sign-up')}
        >
          {m.auth_create_link()}
        </a>
      </p>
    </AuthCard>
  );
}

function SignUpCard() {
  const { signUp } = useSignUp();
  const router = useRouter();
  const target = redirectAfterAuth();
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const id = useId();
  const schema = useMemo(
    () => z.object({ email: emailField, password: newPasswordSchema() }),
    []
  );
  const {
    control,
    formState: { isSubmitting },
    handleSubmit,
  } = useForm({
    defaultValues: { email: '', password: '' },
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });
  const {
    control: codeControl,
    formState: { isSubmitting: codeSubmitting },
    handleSubmit: handleCodeSubmit,
  } = useForm({
    defaultValues: { code: '' },
    resolver: zodResolver(z.object({ code: requiredField })),
  });

  if (step === 'code') {
    return (
      <AuthCard hint={m.auth_code_hint({ email })} title={m.auth_code_title()}>
        <form
          onSubmit={handleCodeSubmit(async ({ code }) => {
            setFormError(null);
            const { error } = await signUp.verifications.verifyEmailCode({
              code,
            });
            if (error) {
              setFormError(clerkMessage(error));
              return;
            }
            const { error: finalizeError } = await signUp.finalize({
              navigate: async () => router.history.push(target),
            });
            if (finalizeError) setFormError(clerkMessage(finalizeError));
          })}
        >
          <FormAlert message={formError} />
          {notice && <p className="t-meta mb-3 text-fg-secondary">{notice}</p>}
          <Controller
            control={codeControl}
            name="code"
            render={({ field, fieldState }) => (
              <Field
                error={fieldState.error}
                id={`${id}-code`}
                label={m.auth_code()}
              >
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  autoComplete="one-time-code"
                  autoFocus
                  id={`${id}-code`}
                  inputMode="numeric"
                />
              </Field>
            )}
          />
          <SubmitButton busy={codeSubmitting}>
            {m.auth_code_submit()}
          </SubmitButton>
        </form>
        <div className="mt-4 flex justify-between text-sm">
          <button
            className="font-semibold text-link hover:text-link-hover"
            onClick={async () => {
              const { error } = await signUp.verifications.sendEmailCode();
              setFormError(error ? clerkMessage(error) : null);
              setNotice(error ? null : m.auth_code_resent());
            }}
            type="button"
          >
            {m.auth_code_resend()}
          </button>
          <button
            className="text-fg-muted hover:text-fg"
            onClick={() => {
              setFormError(null);
              setStep('form');
            }}
            type="button"
          >
            {m.auth_code_back()}
          </button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard hint={m.auth_signup_hint()} title={m.auth_signup_title()}>
      <OAuthButtons onError={setFormError} />
      <form
        onSubmit={handleSubmit(async (values) => {
          setFormError(null);
          const { error } = await signUp.password({
            emailAddress: values.email,
            password: values.password,
          });
          if (error) {
            setFormError(clerkMessage(error));
            return;
          }
          const { error: sendError } =
            await signUp.verifications.sendEmailCode();
          if (sendError) {
            setFormError(clerkMessage(sendError));
            return;
          }
          setEmail(values.email);
          setStep('code');
        })}
      >
        <FormAlert message={formError} />
        <Controller
          control={control}
          name="email"
          render={({ field, fieldState }) => (
            <Field
              error={fieldState.error}
              id={`${id}-email`}
              label={m.auth_email()}
            >
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="email"
                autoFocus
                id={`${id}-email`}
                type="email"
              />
            </Field>
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <Field
              error={fieldState.error}
              id={`${id}-password`}
              label={m.auth_password()}
            >
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="new-password"
                id={`${id}-password`}
                type="password"
              />
              {!fieldState.error && (
                <span className="t-meta text-fg-muted">
                  {m.auth_password_rule()}
                </span>
              )}
            </Field>
          )}
        />
        {/* Clerk mounts its bot-protection widget here; smart mode stays invisible unless challenged. */}
        <div id="clerk-captcha" />
        <SubmitButton busy={isSubmitting}>
          {m.auth_signup_submit()}
        </SubmitButton>
      </form>
      <p className="mt-4 text-center text-fg-secondary text-sm">
        {m.auth_have_account()}{' '}
        <a
          className="font-semibold text-link hover:text-link-hover"
          href={authHref('/sign-in')}
        >
          {m.action_sign_in()}
        </a>
      </p>
    </AuthCard>
  );
}

export function AuthLanding({ mode }: { mode: Mode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  // A signed-in visitor (saved URL, browser history) has nothing to do here.
  useEffect(() => {
    if (isLoaded && isSignedIn) router.history.replace(redirectAfterAuth());
  }, [isLoaded, isSignedIn, router]);
  return (
    <AuthPage>{mode === 'signIn' ? <SignInCard /> : <SignUpCard />}</AuthPage>
  );
}
