import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** An unexpected failure's trace id, small and selectable (one click selects
 * all of it) for a support request: shown only where the error stays on
 * screen. */
export function ErrorId({ className, id }: { className?: string; id: string }) {
  return (
    <span
      className={cn('select-all break-all font-mono text-xs', className)}
      data-testid="error-id"
    >
      {m.error_id({ id })}
    </span>
  );
}
