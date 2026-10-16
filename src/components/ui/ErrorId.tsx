import { useEffect, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

/** An unexpected failure's trace id, small and copyable, for a support
 * request: shown only where the error stays on screen. Its surfaces are alerts,
 * so the id itself is hidden from screen readers (the copy button names it)
 * and the copy is announced through its own polite status. */
export function ErrorId({ className, id }: { className?: string; id: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <span
      className={cn('flex items-center gap-0.5 text-xs', className)}
      data-testid="error-id"
    >
      <span aria-hidden className="min-w-0 break-all font-mono">
        {m.error_id({ id })}
      </span>
      <IconButton
        className="shrink-0 text-current"
        icon={copied ? 'check' : 'copy'}
        label={m.error_id_copy()}
        onClick={() =>
          navigator.clipboard.writeText(id).then(
            () => setCopied(true),
            () => setCopied(false)
          )
        }
        size="xs"
        type="button"
      />
      <span className="sr-only" role="status">
        {copied ? m.error_id_copied() : ''}
      </span>
    </span>
  );
}
