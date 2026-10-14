import type { ComponentProps } from 'react';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Tile } from '@/components/ui/Tile';
import { cn } from '@/lib/cn';

/** A file kind toggle in the Add file dialog's Create and AI generate tabs. */
export function FileKindTile({
  icon,
  ...rest
}: Omit<ComponentProps<typeof Tile>, 'icon'> & {
  icon: FileIconName;
  selected: boolean;
}) {
  return (
    <Tile icon={<FileIcon className="size-5.5" name={icon} />} {...rest} />
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
