import type { ComponentProps } from 'react';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { cn } from '@/lib/cn';

/** A file kind toggle in the Add file dialog's Create and AI generate tabs. */
export function FileKindTile({
  icon,
  label,
  selected,
  className,
  ...rest
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon: FileIconName;
  label: string;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-card border px-2 py-3 font-medium text-sm transition-colors',
        selected
          ? 'border-solid-accent-1 bg-tint-accent-1/60'
          : 'border-line hover:bg-surface-hover-bg',
        className
      )}
      type="button"
      {...rest}
    >
      <FileIcon className="size-5.5" name={icon} />
      {label}
    </button>
  );
}

/** Lays out FileKindTiles: two columns on phones, four from sm. */
export function FileKindGrid({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}
      {...rest}
    />
  );
}
