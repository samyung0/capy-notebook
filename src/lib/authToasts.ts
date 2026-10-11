import { userToast } from '@/components/ui/userToast';
import { signInHref } from '@/features/auth/clerk';
import { m } from '@/i18n';

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
