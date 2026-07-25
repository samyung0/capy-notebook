import type * as React from 'react';

import { cn } from '@/lib/cn';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'field-sizing-content flex min-h-16 w-full rounded-card border border-line bg-surface px-3 py-2 text-base outline-none transition-[colors,border] duration-150 placeholder:text-muted-foreground focus:border-line-strong disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-2 aria-invalid:border-solid-error md:text-sm',
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
