import { cn } from '@/lib/cn';
import { Input, type InputProps } from './Input';

/**
 * The shaded search field of the workspace panels, the question bank and the
 * exam picker: no icon or border, a pointer until it is focused for typing,
 * and the action (clear or close) fading in at its right end, inset as far
 * from the edge as from the top, its hover the colour of the focused or
 * filled field.
 */
export function SearchInput({
  actionClassName,
  className,
  wrapperClassName,
  ...props
}: Omit<InputProps, 'leftIcon' | 'variant'>) {
  return (
    <Input
      actionClassName={cn(
        'motion-icon-in mr-[5px] size-6.5 shrink-0 rounded-md p-1 text-fg-muted hover:bg-fg/12',
        actionClassName
      )}
      className={cn('cursor-pointer focus:cursor-text', className)}
      variant="search"
      wrapperClassName={cn(
        'group/search h-9 w-full cursor-pointer gap-1 pr-0 pl-3.5 text-sm',
        wrapperClassName
      )}
      {...props}
    />
  );
}
