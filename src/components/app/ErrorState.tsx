import type { ReactNode } from 'react';
import { ErrorAction } from '@/components/ui/Button';
import { ErrorId } from '@/components/ui/ErrorId';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export function ErrorState({
  action,
  className,
  description,
  errorId,
  icon = 'error',
  kind,
  testId,
  title,
  variant,
}: {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  /** An unexpected failure's trace id (`unexpectedErrorId`). */
  errorId?: string | null;
  icon?: IconName;
  /** What failed, for tests (`data-error-kind`). */
  kind?: string;
  testId?: string;
  title: ReactNode;
  variant: 'page' | 'panel';
}) {
  return (
    <div
      className={cn(
        'mx-auto flex h-full flex-col items-center justify-center text-center',
        variant === 'page' ? 'max-w-2xl gap-4 px-6' : 'gap-3 px-4',
        className
      )}
      data-error-kind={kind}
      data-error-surface={variant}
      data-testid={testId}
      role="alert"
    >
      <span
        className={cn(
          'flex items-center justify-center bg-tint-error text-tint-error-fg',
          variant === 'page'
            ? 'size-15 rounded-card-lg'
            : 'size-14 rounded-card'
        )}
      >
        <Icon
          className={variant === 'page' ? 'non-scaling-svg size-7' : 'size-6.5'}
          name={icon}
        />
      </span>
      <div className="flex flex-col items-center justify-center gap-1.5">
        {variant === 'page' ? (
          <h1 className="t-large-card-title mt-1">{title}</h1>
        ) : (
          <p className="t-card-title mt-1 font-bold">{title}</p>
        )}
        {description && (
          <p
            className={
              variant === 'page' ? 't-subtitle font-medium' : 'font-medium'
            }
          >
            {description}
          </p>
        )}
        {errorId && <ErrorId className="text-fg-muted" id={errorId} />}
      </div>
      {action && (
        <div className={variant === 'page' ? 'mt-4' : 'mt-3'}>{action}</div>
      )}
    </div>
  );
}

/** A failed read in a small area (a side card, a popover list): one line and
 * Retry, where the panel's icon tile would not fit. */
export function InlineErrorState({
  className,
  message,
  onRetry,
}: {
  className?: string;
  message: ReactNode;
  onRetry: () => void;
}) {
  return (
    <div
      className={cn('flex flex-col items-center gap-1 text-center', className)}
      data-error-surface="inline"
      role="alert"
    >
      <p className="text-fg-muted">{message}</p>
      <ErrorAction onClick={onRetry} size="sm">
        {m.error_action_retry()}
      </ErrorAction>
    </div>
  );
}
