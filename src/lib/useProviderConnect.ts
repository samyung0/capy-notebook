/**
 * Link a Google/Microsoft account through Clerk external accounts.
 *
 * OAuth is fully delegated to Clerk: the frontend creates (or reauthorizes)
 * the external account with the Drive/Graph scopes we need, redirects the
 * user to the provider's consent screen via Clerk, and the Go backend later
 * pulls fresh access tokens from Clerk's OAuth token wallet.
 *
 * Note: the extra scopes below must be allowed on the Clerk dashboard's
 * Google/Microsoft SSO connections (requires custom OAuth credentials).
 * Google uses drive.file so Picker setAppId can grant the picked files.
 */
import { useUser } from '@clerk/react';
import { USE_MSW } from '@/api/auth';

export type ConnectProvider = 'google' | 'microsoft';

const SCOPES: Record<ConnectProvider, string[]> = {
  google: ['https://www.googleapis.com/auth/drive.file'],
  microsoft: ['Files.Read', 'offline_access'],
};

function useClerkProviderConnect() {
  const { user } = useUser();
  return async (provider: ConnectProvider): Promise<void> => {
    if (!user) throw new Error('Not signed in');
    const redirectUrl = window.location.href;
    const additionalScopes = SCOPES[provider];
    const existing = user.externalAccounts.find((a) => a.provider === provider);
    const account = existing
      ? await existing.reauthorize({ additionalScopes, redirectUrl })
      : await user.createExternalAccount({
          additionalScopes,
          redirectUrl,
          strategy: `oauth_${provider}`,
        });
    const url = account.verification?.externalVerificationRedirectURL;
    if (url) window.location.assign(url.toString());
  };
}

function useMockProviderConnect() {
  return async (_provider: ConnectProvider): Promise<void> => {
    /* MSW / auth-disabled mode: callers short-circuit before connecting. */
  };
}

function useClerkMicrosoftLoginHint() {
  const { user } = useUser();
  return user?.externalAccounts.find(
    (account) => account.provider === 'microsoft'
  )?.emailAddress;
}

function useMockMicrosoftLoginHint(): string | undefined {
  /* MSW / auth-disabled mode: no Clerk Microsoft email. */
  const hint: string | undefined = undefined;
  return hint;
}

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
export const useProviderConnect = CLERK_ACTIVE
  ? useClerkProviderConnect
  : useMockProviderConnect;
export const useMicrosoftLoginHint = CLERK_ACTIVE
  ? useClerkMicrosoftLoginHint
  : useMockMicrosoftLoginHint;
