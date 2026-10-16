import { toast as sonnerToast } from 'sonner';
import {
  CALLOUT_ICON,
  CALLOUT_VARIANT_CLASS,
} from '@/features/notes/richBlockConfig';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { ContentSwap } from './ContentSwap';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

type ToastVariant = 'default' | 'error' | 'success' | 'warning';

/** Toasts share the callout look, except the default toast is grey where a
 * callout would use the blue info tint. */
const TOAST_CALLOUT = {
  default: 'info',
  error: 'danger',
  success: 'success',
  warning: 'warning',
} as const;

const TOAST_VARIANT_CLASS: Record<ToastVariant, string> = {
  default: 'border-line bg-surface-hover-bg text-fg',
  error: cn(CALLOUT_VARIANT_CLASS.danger, 'motion-error-shake delay-750'),
  success: CALLOUT_VARIANT_CLASS.success,
  warning: CALLOUT_VARIANT_CLASS.warning,
};

function Toast(props: ToastProps) {
  const {
    title,
    description,
    button,
    id,
    showCloseButton = true,
    variant = 'default',
  } = props;
  return (
    <div
      className={cn(
        'pointer-events-auto relative z-9999 flex w-full min-w-[280px] max-w-96 flex-row items-start gap-3 rounded-lg border p-3.5 shadow-card',
        TOAST_VARIANT_CLASS[variant]
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon
          className="mt-0.5 size-4.5 shrink-0 -translate-y-px"
          name={CALLOUT_ICON[TOAST_CALLOUT[variant]]}
        />
        <ContentSwap
          className="wrap-anywhere min-w-0 flex-1"
          contentKey={JSON.stringify([title, description])}
        >
          <span className="block font-bold text-sm">{title}</span>
          {description && (
            <span className="mt-0.5 block whitespace-pre-line text-[13px]">
              {description}
            </span>
          )}
        </ContentSwap>
      </div>
      {/* The negative margin centres the 28px button on the 20px title line. */}
      {button && (
        <Button
          className="wrap-anywhere -my-1 h-auto min-h-6.5 max-w-[94px] shrink-0 whitespace-normal rounded-lg px-2.5 py-1 text-center text-[13px] leading-4.5 sm:max-w-[130px]"
          onClick={() => {
            button.onClick();
            sonnerToast.dismiss(id);
          }}
          size="sm"
          type="button"
        >
          {button.label}
        </Button>
      )}
      {showCloseButton && (
        <IconButton
          className="absolute -top-2.5 -left-2.5 size-6.5 rounded-full border border-divider bg-surface p-0 text-fg-secondary shadow-card hover:bg-surface-hover-bg"
          icon="x"
          label={m.action_close()}
          onClick={() => {
            sonnerToast.dismiss(id);
          }}
          size="xs"
          strokeWidth={2}
          type="button"
        />
      )}
    </div>
  );
}

interface ToastProps {
  button?: {
    label: string;
    onClick: () => void;
  };
  description?: string;
  id: string | number;
  showCloseButton?: boolean;
  title: string;
  variant?: ToastVariant;
}

export { Toast, type ToastProps };
