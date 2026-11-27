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
  label = m.material_unsupported_block(),
  ...props
}: ComponentProps<'span'> & {
  inToolbar?: boolean;
  /** What cannot be shown, when it is not a block ("This film can't be shown"). */
  label?: string;
}) {
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
      {label}
    </span>
  );
}
