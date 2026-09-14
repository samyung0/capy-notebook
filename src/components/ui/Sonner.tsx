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
  'items-top pointer-events-auto relative z-9999 w-full min-w-64 flex-row rounded-card px-5 py-4 shadow-card md:max-w-91',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: '',
        error: 'border-tint-error bg-tint-error text-tint-error-fg md:max-w-96',
        success:
          'border-tint-success bg-tint-success text-tint-success-fg md:max-w-96',
        warning:
          'border-tint-warning bg-tint-warning text-tint-warning-fg md:max-w-96',
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
    >
      {showCloseButton && (
        <IconButton
          className="absolute -top-2 -left-2"
          icon="x"
          onClick={() => {
            sonnerToast.dismiss(id);
          }}
          size="xs"
          variant="outline"
        >
          <span className="sr-only">{m.action_close()}</span>
        </IconButton>
      )}
      <div className="items-top flex flex-1 gap-1.5">
        {variant === 'error' && (
          <Icon className="size-5" name="error" strokeWidth={2} />
        )}
        {variant === 'warning' && (
          <Icon className="size-5" name="warning" strokeWidth={2} />
        )}
        {variant === 'success' && (
          <Icon className="size-5" name="check" strokeWidth={2} />
        )}
        <ContentSwap
          className="w-full"
          contentKey={JSON.stringify([title, description])}
        >
          <span
            className={cn(
              'flex items-start font-semibold',
              (variant === 'warning' || variant === 'error') && 'font-bold'
            )}
          >
            <span>{title}</span>
          </span>
          <span className="mt-1 block font-medium text-fg-muted text-sm">
            {description}
          </span>
        </ContentSwap>
      </div>
      {button && (
        <div className="ml-5 shrink-0">
          <Button
            className="translate-y-1 rounded-md px-2.5"
            onClick={() => {
              button.onClick();
              sonnerToast.dismiss(id);
            }}
            size="sm"
          >
            {button.label}
          </Button>
        </div>
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
