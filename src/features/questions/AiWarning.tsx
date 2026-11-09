import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

/** A rule an answer broke, as the AI wrote it (Epo 2026-11-05): amber, or red
 * where code told what happened (copying, instructions to the marker). */
export function AiWarning({
  className,
  flag,
  message,
}: {
  className?: string;
  flag?: string;
  message: string;
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-lg px-3 py-2 text-sm',
        flag
          ? 'bg-tint-error text-tint-error-fg'
          : 'bg-tint-warning text-tint-warning-fg',
        className
      )}
      data-ai-warning
    >
      <Icon className="mt-0.5 size-4 shrink-0" name="alert" />
      <span className="min-w-0">{message}</span>
    </p>
  );
}
