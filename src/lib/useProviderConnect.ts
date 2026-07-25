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
 */
import { useUser } from '@clerk/react';
import { USE_MSW } from '@/api/auth';

export type ConnectProvider = 'google' | 'microsoft';

const SCOPES: Record<ConnectProvider, string[]> = {
  google: ['https://www.googleapis.com/auth/drive.readonly'],
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

/** Module-level split keeps Clerk hooks out of the tree when there is no
 * ClerkProvider (MSW mode, or missing publishable key) — mirrors the
 * conditions in AppAuthProvider. */
const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
export const useProviderConnect = CLERK_ACTIVE
  ? useClerkProviderConnect
  : useMockProviderConnect;
