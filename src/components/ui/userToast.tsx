import { toast as sonnerToast } from 'sonner';
import { Toast, type ToastProps } from './Sonner';

export function userToast({
  id: toastId,
  ...toast
}: Omit<ToastProps, 'id'> & { id?: string | number }) {
  return sonnerToast.custom(
    (id) => <Toast {...toast} id={id} />,
    toastId === undefined ? undefined : { id: toastId }
  );
}
