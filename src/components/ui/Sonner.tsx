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
  'pointer-events-auto relative z-9999 w-full min-w-0 max-w-96 flex-row items-center gap-3 rounded-card shadow-card md:gap-2.5 md:p-3.5',
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
            'size-5 shrink-0 self-start',
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
          <span className="mt-0.75 block whitespace-pre-line font-medium text-[13px] text-fg-secondary leading-4.5">
            {description}
          </span>
        )}
      </ContentSwap>
      {button && (
        <Button
          className="wrap-anywhere h-auto min-h-7.5 max-w-[94px] shrink-0 whitespace-normal rounded-lg px-3 py-1.5 text-center leading-4.5 sm:max-w-[130px]"
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
          className="absolute -top-2 -left-2 size-5 rounded-full border border-divider bg-surface p-0 text-fg-secondary shadow-card hover:bg-surface-hover-bg [&>svg]:size-3"
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
