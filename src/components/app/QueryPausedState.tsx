import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export function QueryPausedState({
  className = 'min-h-40',
}: {
  className?: string;
}) {
  return (
    <div
      className={cn('flex items-center justify-center gap-2', className)}
      role="status"
    >
      <Icon className="size-5 -translate-y-px" name="wifiError" />
      <p>{m.connection_waiting()}</p>
    </div>
  );
}
