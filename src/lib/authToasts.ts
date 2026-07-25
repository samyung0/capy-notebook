import { isApiError } from '@/api/client';
import { userToast } from '@/components/ui/userToast';

/** Safe same-origin return path for post-auth redirect. */
export function signInHref(
  returnTo = `${window.location.pathname}${window.location.search}`
) {
  const path =
    returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  return `/sign-in?${new URLSearchParams({ redirect_url: path })}`;
}

export function toastCloneError(
  err: unknown,
  kind: 'workspace' | 'quiz' | 'deck'
) {
  if (isApiError(err) && err.status === 401) {
    userToast({
      button: {
        label: 'Sign in',
        onClick: () => {
          window.location.href = signInHref();
        },
      },
      description: `Create an account before cloning this ${kind}.`,
      title: 'Sign in to clone',
    });
    return;
  }
  userToast({
    description:
      err instanceof Error
        ? err.message
        : 'Something went wrong. Please try again.',
    title: 'Could not clone',
    variant: 'error',
  });
}

export function toastSignInRequired(title: string, description: string) {
  userToast({
    button: {
      label: 'Sign in',
      onClick: () => {
        window.location.href = signInHref();
      },
    },
    description,
    title,
  });
}
