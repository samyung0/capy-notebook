import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';

export function WarningBanner({
  message,
  action,
  icon = 'error',
}: {
  message?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div
      className="flex w-full items-start gap-2.5 rounded-card border border-solid-error/30 bg-tint-error p-4 text-[0.95rem] text-tint-error-fg"
      role="alert"
    >
      <Icon className="mt-0.5 size-4.5 shrink-0" name={icon} />
      <div className="min-w-0 flex-1">
        <p>{message}</p>
        {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}
