import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export interface FileBannerAction {
  disabled?: boolean;
  label: string;
  onClick: () => void;
}

/**
 * Flat strip under a file or material header. Closing hides it until the
 * message changes or the page remounts it; nothing is remembered.
 */
export function FileBanner({
  message,
  tone = 'neutral',
  actions = [],
  testId,
}: {
  message: string;
  tone?: 'neutral' | 'error';
  actions?: FileBannerAction[];
  testId?: string;
}) {
  const [closed, setClosed] = useState<string | null>(null);
  if (closed === message) return null;
  return (
    <div
      className={cn(
        'flex shrink-0 items-start gap-3 border-b py-2 pr-2 pl-4 text-fg text-sm',
        tone === 'error'
          ? 'border-solid-error/40 bg-tint-error'
          : 'border-divider bg-surface-hover-bg'
      )}
      data-testid={testId}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <div className="min-w-0 flex-1 pt-0.5">
        <p>{message}</p>
        {actions.length > 0 && (
          <div className="mt-1 -mr-8.5 flex flex-wrap justify-end gap-1">
            {actions.map((action) => (
              <Button
                className="h-7 px-2 underline underline-offset-3 hover:bg-fg/5"
                disabled={action.disabled}
                key={action.label}
                onClick={action.onClick}
                size="sm"
                variant="ghost"
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton
        className="shrink-0 rounded-[7px] opacity-75 hover:bg-fg/5 hover:opacity-100"
        icon="x"
        label={m.action_close()}
        onClick={() => setClosed(message)}
        size="xs"
      />
    </div>
  );
}
