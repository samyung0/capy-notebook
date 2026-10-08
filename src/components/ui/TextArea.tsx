import type * as React from 'react';

import { cn } from '@/lib/cn';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'field-sizing-content aria-invalid:motion-error-shake flex max-h-[calc(5lh+var(--spacing)*4+2px)] min-h-16 w-full overflow-y-auto rounded-card border border-line bg-field px-3.5 py-2.5 outline-none transition-colors duration-150 placeholder:text-placeholder focus:border-action-accent disabled:cursor-not-allowed disabled:bg-field-disabled disabled:text-fg-muted aria-invalid:border-solid-error',
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
