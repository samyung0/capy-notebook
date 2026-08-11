import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

export function ErrorState({
  action,
  className,
  description,
  testId,
  title,
  variant,
}: {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
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
          className={variant === 'page' ? 'size-7' : 'size-6.5'}
          name="warning"
        />
      </span>
      <div className="flex flex-col items-center justify-center gap-1.5">
        {variant === 'page' ? (
          <h1 className="t-large-card-title mt-1">{title}</h1>
        ) : (
          <p className="t-card-title mt-1 font-bold">{title}</p>
        )}
        {description && (
          <p className={variant === 'page' ? 't-subtitle font-medium' : ''}>
            {description}
          </p>
        )}
      </div>
      {action && (
        <div className={variant === 'page' ? 'mt-4' : 'mt-2'}>{action}</div>
      )}
    </div>
  );
}
