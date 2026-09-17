import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Panel } from '@/components/app/layout';
import { BASE_BUTTON_STYLE, Button } from '@/components/ui/Button';
import { ButtonCard } from '@/components/ui/ButtonCard';
import { Card } from '@/components/ui/Card';
import { ContentSwap } from '@/components/ui/ContentSwap';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputField } from '@/components/ui/Input';
import { useAuth, useSignIn, useSignUp } from '@/features/auth/clerkHooks';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { clerkMessage, redirectAfterAuth, ssoUrls } from './clerk';
import { GoogleIcon, MicrosoftIcon } from './ProviderIcons';
import { newPasswordSchema, signInPasswordSchema } from './password';

type Mode = 'signIn' | 'signUp';

export function AuthPage({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-dvh overflow-hidden p-1.5 sm:p-2.5">
      <Panel
        className="h-full w-full"
        sectionClassName="h-full w-full min-h-full flex flex-row"
      >
        <div className="flex flex-1 flex-col gap-4 p-6 md:p-8">
          <div className="flex flex-1 items-center justify-center">
            <div className="w-sm">{children}</div>
          </div>
        </div>
        <div className="relative hidden flex-1 xl:block">
          <BrandColumn />
        </div>
      </Panel>
    </main>
  );
}

function BrandColumn() {
  return (
    <Card
      className={cn(
        'relative flex h-full flex-1 flex-col items-center justify-center gap-10 bg-[#322a5c] p-11 text-[#f7f7f7]'
      )}
      radius="card"
      theme="surface-dark"
    >
      <figure className="authBlockquote -mt-6 min-w-sm max-w-[600px]">
        <blockquote>
          <p>
            Perhaps studying is not about the destination. Perhaps it is about
            the promise engraved in each step you take, that the seeking itself
            is the answer.{' '}
          </p>
        </blockquote>
        <figcaption className="mt-7 flex items-center gap-3 font-sans tracking-wide">
          <span
            aria-hidden="true"
            className="h-0.5 w-11 flex-none bg-action-accent"
          />
          <span>Metal Garden Enthusiast</span>
        </figcaption>
      </figure>
    </Card>
  );
}

export function AuthCard({
  title,
  hint,
  children,
  className,
  containerClassName,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
}) {
  return (
    <Card
      border="none"
      className={cn('gap-1.5 p-0', containerClassName)}
      radius="card-lg"
    >
      <h2 className="t-page-title self-center xl:self-start">{title}</h2>
      {hint && (
        <p className="t-card-title self-center text-center text-fg-muted xl:self-start xl:text-left">
          {hint}
        </p>
      )}
      <div className={cn('mt-7', className)}>{children}</div>
    </Card>
  );
}

export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="mt-2 w-full rounded-button bg-tint-error px-3 py-2 text-sm text-tint-error-fg"
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
    <div className="mt-4 flex flex-col gap-0">
      <p className="t-label my-2 flex items-center gap-3 text-fg-muted uppercase before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        {m.auth_or()}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <ButtonCard
          buttonText={'Google'}
          className="w-full flex-1 gap-1.5! py-3"
          componentBeforeText={<GoogleIcon className="h-6 w-6 shrink-0" />}
          onClick={() => void start('oauth_google')}
        />
        <ButtonCard
          buttonText={'Microsoft'}
          className="w-full flex-1 gap-1.5! py-3"
          componentBeforeText={<MicrosoftIcon className="h-6 w-6 shrink-0" />}
          onClick={() => void start('oauth_microsoft')}
        />
      </div>
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

const emailField = z.email({ error: () => m.auth_field_required() });
const requiredField = z
  .string()
  .trim()
  .min(1, {
    error: () => m.auth_field_required(),
  });

/** New-password form, shared by the breached-password step and the reset page. */
export function NewPasswordForm({
  submitLabel,
  onSubmit,
}: {
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
    resolver: zodResolver(schema),
  });
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();
  return (
    <form
      className="relative flex flex-col gap-2"
      onSubmit={handleSubmit(async ({ password }) => {
        setFormError(await onSubmit(password));
      })}
    >
      <Controller
        control={control}
        name="password"
        render={({ field, fieldState }) => (
          <InputField
            error={fieldState.error}
            id={id}
            label={m.auth_new_password()}
          >
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="new-password"
              autoFocus
              id={id}
              type="password"
            />
            {!fieldState.error && (
              <span className="t-meta pt-1.5 text-fg-muted">
                {m.auth_password_rule()}
              </span>
            )}
          </InputField>
        )}
      />
      <SubmitButton busy={isSubmitting}>{submitLabel}</SubmitButton>
      <FormAlert message={formError} />
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
      <AuthCard
        hint={m.auth_new_password_breach_hint()}
        title={m.auth_new_password_title()}
      >
        <NewPasswordForm
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
      <form
        className="relative flex flex-col gap-2"
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
        <Controller
          control={control}
          name="email"
          render={({ field, fieldState }) => (
            <InputField
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
                placeholder={'Enter your email address...'}
                type="email"
              />
            </InputField>
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <InputField
              error={fieldState.error}
              id={`${id}-password`}
              label={m.auth_password()}
              trailing={
                <Link
                  className="font-semibold text-link text-sm hover:text-link-hover"
                  search
                  to="/forgot-password"
                >
                  {m.auth_forgot()}
                </Link>
              }
            >
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="current-password"
                id={`${id}-password`}
                placeholder={'and password...'}
                type="password"
              />
            </InputField>
          )}
        />
        <SubmitButton busy={isSubmitting}>{m.action_sign_in()}</SubmitButton>
        <FormAlert message={formError} />
      </form>
      <OAuthButtons onError={setFormError} />
      <p className="mt-7 text-center text-fg-secondary text-sm">
        {m.auth_new_here()}{' '}
        <Link
          className="font-semibold text-link underline hover:text-link-hover"
          search
          to="/sign-up"
        >
          {m.auth_create_link()}
        </Link>
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
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [resending, setResending] = useState(false);
  const sendingRef = useRef(false);
  const remaining =
    sentAt === null
      ? 0
      : Math.max(0, Math.ceil((sentAt + 61_500 - now) / 1000));
  const justSent = sentAt !== null && now - sentAt < 1500;
  const resendLabel = justSent
    ? m.auth_code_sent()
    : remaining > 0
      ? m.auth_code_resend_cooldown({
          seconds: String(Math.min(60, remaining)),
        })
      : m.auth_code_resend();
  const coolingDown = remaining > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [coolingDown]);
  const markCodeSent = () => {
    const time = Date.now();
    setSentAt(time);
    setNow(time);
  };
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
      <>
        <Button
          className="mb-5 flex h-fit items-center p-0 underline"
          iconLeft="navigationBack"
          iconLeftClassName="mr-1 size-4.5"
          onClick={() => {
            setFormError(null);
            setStep('form');
          }}
          type="button"
          variant="ghost-link"
        >
          {m.auth_code_back()}
        </Button>
        <AuthCard hint={m.auth_code_hint()} title={m.auth_code_title()}>
          <form
            className="relative flex flex-col gap-2"
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
            <Controller
              control={codeControl}
              name="code"
              render={({ field, fieldState }) => (
                <InputField
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
                </InputField>
              )}
            />
            <SubmitButton busy={codeSubmitting}>
              {m.auth_code_submit()}
            </SubmitButton>
            <FormAlert message={formError} />
          </form>
          <div className="mt-6 flex justify-between text-sm">
            <button
              className={cn(
                BASE_BUTTON_STYLE,
                'font-semibold text-link hover:text-link-hover disabled:cursor-default disabled:text-fg-muted'
              )}
              disabled={remaining > 0 || resending}
              onClick={async () => {
                if (
                  sendingRef.current ||
                  (sentAt !== null && Date.now() < sentAt + 61_500)
                )
                  return;
                sendingRef.current = true;
                setResending(true);
                try {
                  const { error } = await signUp.verifications.sendEmailCode();
                  setFormError(error ? clerkMessage(error) : null);
                  if (!error) markCodeSent();
                } catch {
                  setFormError(m.auth_error_generic());
                } finally {
                  sendingRef.current = false;
                  setResending(false);
                }
              }}
              type="button"
            >
              <ContentSwap
                contentKey={
                  justSent ? 'sent' : remaining > 0 ? 'cooldown' : 'resend'
                }
                kind="text-state"
              >
                {resendLabel}
              </ContentSwap>
            </button>
          </div>
        </AuthCard>
      </>
    );
  }

  return (
    <AuthCard hint={m.auth_signup_hint()} title={m.auth_signup_title()}>
      <form
        className="relative flex flex-col gap-2"
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
          markCodeSent();
          setStep('code');
        })}
      >
        <Controller
          control={control}
          name="email"
          render={({ field, fieldState }) => (
            <InputField
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
                placeholder={'Enter your email address...'}
                type="email"
              />
            </InputField>
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <InputField
              error={fieldState.error}
              id={`${id}-password`}
              label={m.auth_password()}
            >
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoComplete="new-password"
                id={`${id}-password`}
                placeholder={'and password...'}
                type="password"
              />
              {!fieldState.error && (
                <span className="t-meta pt-1.5 text-fg-muted">
                  {m.auth_password_rule()}
                </span>
              )}
            </InputField>
          )}
        />
        {/* Clerk mounts its bot-protection widget here; smart mode stays invisible unless challenged. */}
        <div id="clerk-captcha" />
        <SubmitButton busy={isSubmitting}>
          {m.auth_signup_submit()}
        </SubmitButton>
        <FormAlert message={formError} />
      </form>
      <OAuthButtons onError={setFormError} />
      <p className="mt-7 text-center text-fg-secondary text-sm">
        {m.auth_have_account()}{' '}
        <Link
          className="font-semibold text-link underline hover:text-link-hover"
          search
          to={'/sign-in'}
        >
          {m.action_sign_in()}
        </Link>
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
