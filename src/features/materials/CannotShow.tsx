import type { ComponentProps } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** "This block cannot be shown": where a note's block from a newer version
 * is, and in place of a block or part whose code could not load (Epo
 * 2026-11-20). `inToolbar` stands in a block toolbar for the button it
 * replaces. Free of Plate, so shared pages and question views take it. */
export function CannotShow({
  className,
  inToolbar = false,
  ...props
}: ComponentProps<'span'> & { inToolbar?: boolean }) {
  return (
    <span
      className={cn(
        'block font-sans text-fg-muted text-sm',
        inToolbar && 'whitespace-nowrap px-2',
        className
      )}
      contentEditable={false}
      {...props}
    >
      {m.material_unsupported_block()}
    </span>
  );
}
