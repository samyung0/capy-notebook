import { cva, type VariantProps } from 'class-variance-authority';
import { toast as sonnerToast } from 'sonner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { Card } from './Card';
import { ContentSwap } from './ContentSwap';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

const sonnerCardVariants = cva(
  'pointer-events-auto relative z-9999 w-full min-w-0 max-w-96 flex-row items-start gap-2 rounded-card shadow-card md:gap-2.5 md:p-3.5',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'bg-surface',
        error: 'motion-error-shake border-tint-error bg-tint-error delay-750',
        success: 'border-tint-success bg-tint-success',
        warning: 'border-tint-warning bg-tint-warning',
      },
    },
  }
);

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
    <Card
      border="solid"
      className={cn(sonnerCardVariants({ variant }))}
      radius="row"
      theme="transparent"
    >
      {(variant === 'error' ||
        variant === 'warning' ||
        variant === 'success') && (
        <Icon
          className={cn(
            'size-5 shrink-0',
            variant === 'error' && 'text-tint-error-fg',
            variant === 'warning' && 'text-tint-warning-fg',
            variant === 'success' && 'text-tint-success-fg'
          )}
          name={variant === 'success' ? 'check' : 'error'}
          strokeWidth={2}
        />
      )}
      <ContentSwap
        className="wrap-anywhere min-w-0 flex-1"
        contentKey={JSON.stringify([title, description])}
      >
        <span className="block font-bold text-sm leading-5">{title}</span>
        {description && (
          <span className="mt-0.75 block font-medium text-[13px] text-fg-secondary leading-4.5">
            {description}
          </span>
        )}
      </ContentSwap>
      {button && (
        <Button
          className="wrap-anywhere -mt-1.25 h-auto min-h-7.5 max-w-[130px] shrink-0 whitespace-normal px-2 py-1.5 text-left font-bold leading-4.5 max-[420px]:max-w-[94px] max-[420px]:px-1.5 md:mx-2"
          onClick={() => {
            button.onClick();
            sonnerToast.dismiss(id);
          }}
          size="sm"
          type="button"
          variant={variant === 'default' ? 'ghost-hover' : 'ghost'}
        >
          {button.label}
        </Button>
      )}
      {showCloseButton && (
        <IconButton
          className="-mt-0.5 size-6 shrink-0 rounded-[7px] text-fg-secondary"
          icon="x"
          label={m.action_close()}
          onClick={() => {
            sonnerToast.dismiss(id);
          }}
          size="xs"
          type="button"
          variant={variant === 'default' ? 'ghost-hover' : 'ghost'}
        />
      )}
    </Card>
  );
}

interface ToastProps extends VariantProps<typeof sonnerCardVariants> {
  button?: {
    label: string;
    onClick: () => void;
  };
  description?: string;
  id: string | number;
  showCloseButton?: boolean;
  title: string;
}

export { Toast, type ToastProps };
