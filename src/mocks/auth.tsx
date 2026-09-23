import { useEffect, useState } from 'react';
import { redirectAfterAuth } from '@/features/auth/clerk';

type Result = { error: { message: string } | null; status?: string };

const requests = new Set<AbortController>();
export function cancelMockAuthRequests() {
  for (const request of requests) request.abort();
}

// Deliberately send no entered passwords, email addresses, codes or photos.
// These local-only endpoints model outcomes, never an identity provider.
export async function mockAuthAction(operation: string): Promise<Result> {
  const controller = new AbortController();
  requests.add(controller);
  try {
    const response = await fetch(`/__mock/auth/${operation}`, {
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Mock auth request failed');
    return await response.json();
  } catch {
    return {
      error: { message: 'Unable to reach the mock authentication service.' },
    };
  } finally {
    requests.delete(controller);
  }
}

const action = (operation: string) => () => mockAuthAction(operation);
const signIn = {
  create: action('reset-start'),
  finalize: async ({ navigate }: { navigate: () => Promise<void> }) => {
    const result = await mockAuthAction('finalize');
    if (!result.error) await navigate();
    return result;
  },
  password: async () => {
    const result = await mockAuthAction('sign-in');
    signIn.status = result.status ?? 'complete';
    return result;
  },
  resetPasswordEmailCode: {
    sendCode: action('send-code'),
    submitPassword: action('new-password'),
    verifyCode: action('verify-code'),
  },
  sso: async () => {
    const result = await mockAuthAction('sso');
    if (!result.error) {
      window.location.assign(`/sso-callback${window.location.search}`);
    }
    return result;
  },
  status: 'complete',
};

const signUp = {
  finalize: signIn.finalize,
  password: action('sign-up'),
  verifications: {
    sendEmailCode: action('send-code'),
    verifyEmailCode: action('verify-code'),
  },
};

export const useAuth = () => ({ isLoaded: true, isSignedIn: false });
export const useSignIn = () => ({ signIn });
export const useSignUp = () => ({ signUp });

const user = {
  setProfileImage: async () => {
    const result = await mockAuthAction('profile-image');
    if (result.error) throw result.error;
  },
  unsafeMetadata: {},
  updateMetadata: async () => {
    const result = await mockAuthAction('profile-metadata');
    if (result.error) throw result.error;
  },
};

// Each panel launch can preview first-run onboarding again.
export const useUser = () => ({ isLoaded: true, user });

export function AuthenticateWithRedirectCallback() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void mockAuthAction('sso-callback').then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error.message);
      else window.location.replace(redirectAfterAuth());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return error ? <p role="alert">{error}</p> : null;
}
