import { Panel } from '@/components/app/layout';
import { redirectAfterAuth } from '@/features/auth/clerk';
import { AuthenticateWithRedirectCallback } from '@/features/auth/clerkHooks';
import { m } from '@/i18n';

/** Google and Microsoft return here. Clerk completes the session, or transfers
 * a first-time account into sign-up, then lands on `redirect_url`. */
export default function SsoCallbackPage() {
  const target = redirectAfterAuth();
  return (
    <main
      aria-label={m.a11y_loading()}
      className="h-svh overflow-hidden p-1.5 sm:p-2.5"
      role="status"
    >
      <Panel
        className="h-full w-full"
        sectionClassName="h-full w-full min-h-full flex flex-row items-center justify-center"
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
        <span className="t-card-title font-bold">{m.auth_sso_wait()}</span>
      </Panel>
    </main>
  );
}
