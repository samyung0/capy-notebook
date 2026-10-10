import { cn } from '@/lib/cn';

export function Toolbar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center gap-0 border-divider border-b bg-surface/95 px-1 backdrop-blur-sm sm:h-10 sm:px-2',
        className
      )}
      {...props}
    />
  );
}

export function ToolbarGroup({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex h-full shrink-0 items-center gap-0 after:mx-1 after:h-5 after:w-px after:bg-divider last:after:hidden sm:after:mx-1.5 sm:after:h-7',
        className
      )}
      data-toolbar-group
      {...props}
    />
  );
}
