import { toast as sonnerToast } from 'sonner';
import { Toast, type ToastProps } from './Sonner';

export function userToast({
  id: toastId,
  ...toast
}: Omit<ToastProps, 'id'> & { id?: string | number }) {
  return sonnerToast.custom((id) => <Toast {...toast} id={id} />, {
    duration:
      toast.variant === 'error' || toast.variant === 'warning'
        ? 7000
        : undefined,
    id: toastId,
  });
}
