import { AuthenticateWithRedirectCallback } from '@clerk/react';
import { redirectAfterAuth } from '@/features/auth/clerk';
import { m } from '@/i18n';

/** Google and Microsoft return here. Clerk completes the session, or transfers
 * a first-time account into sign-up, then lands on `redirect_url`. */
export default function SsoCallbackPage() {
  const target = redirectAfterAuth();
  return (
    <div
      aria-label={m.a11y_loading()}
      className="flex min-h-dvh items-center justify-center bg-page text-fg-muted"
      role="status"
    >
      {/* A first-time OAuth account transfers into sign-up here, which can
          still draw a bot-protection challenge. */}
      <div id="clerk-captcha" />
      <AuthenticateWithRedirectCallback
        signInForceRedirectUrl={target}
        signInUrl="/sign-in"
        signUpForceRedirectUrl={target}
        signUpUrl="/sign-up"
      />
      {m.auth_sso_wait()}
    </div>
  );
}
