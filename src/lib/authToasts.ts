import { isApiError, isStorageQuotaError } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { trackQuotaBlocked } from '@/lib/observability';

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
  kind: 'workspace' | 'quiz' | 'flashcards'
) {
  if (isStorageQuotaError(err)) {
    trackQuotaBlocked(err, 'clone');
    userToast({
      description: m.clone_quota_body(),
      title: m.clone_quota_title(),
      variant: 'error',
    });
    return;
  }
  if (isApiError(err) && err.status === 401) {
    userToast({
      button: {
        label: m.action_sign_in(),
        onClick: () => {
          window.location.href = signInHref();
        },
      },
      description:
        kind === 'workspace'
          ? m.clone_signin_workspace()
          : kind === 'quiz'
            ? m.clone_signin_quiz()
            : m.clone_signin_flashcards(),
      title: m.clone_signin_title(),
    });
    return;
  }
  userToast({
    description: err instanceof Error ? err.message : m.source_try_again(),
    title: m.clone_failed(),
    variant: 'error',
  });
}

export function toastSignInRequired(title: string, description: string) {
  userToast({
    button: {
      label: m.action_sign_in(),
      onClick: () => {
        window.location.href = signInHref();
      },
    },
    description,
    title,
  });
}
