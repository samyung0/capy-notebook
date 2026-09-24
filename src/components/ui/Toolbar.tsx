import { cn } from '@/lib/cn';

export function Toolbar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center gap-0 border-divider border-b bg-surface/95 px-2 backdrop-blur-sm',
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
        'flex h-full shrink-0 items-center gap-0 after:mx-1.5 after:h-7 after:w-px after:bg-divider last:after:hidden',
        className
      )}
      data-toolbar-group
      {...props}
    />
  );
}
