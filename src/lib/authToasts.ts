import { isApiError, isStorageQuotaError } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import { signInHref } from '@/features/auth/clerk';
import { m } from '@/i18n';
import { trackQuotaBlocked } from '@/lib/observability';

export function toastCloneError(
  err: unknown,
  kind: 'workspace' | 'quiz' | 'flashcards' | 'material'
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
            : kind === 'material'
              ? m.clone_signin_material()
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
