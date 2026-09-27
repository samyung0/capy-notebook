import { useId } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { PopoverContent } from '@/components/ui/Popover';
import { cn } from '@/lib/cn';

export function ToolbarPopoverContent({
  className,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      className={cn(
        'gap-0 rounded-lg px-1 py-1.5 font-medium text-fg text-sm leading-(--body-line-height)',
        className
      )}
      {...props}
    />
  );
}

export function ToolbarPopoverButton({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(
        'h-7 w-full justify-start gap-2 rounded-lg px-2 py-0 text-left font-medium leading-(--body-line-height) [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:-translate-y-px',
        className
      )}
      size="sm"
      type="button"
      variant="ghost-hover"
      {...props}
    />
  );
}

export function ToolbarPopoverItem({
  label,
  icon,
  shortcut,
  selected,
  ...props
}: React.ComponentProps<typeof ToolbarPopoverButton> & {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  selected?: boolean;
}) {
  return (
    <ToolbarPopoverButton aria-pressed={selected} {...props}>
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{label}</span>
      {shortcut && (
        <kbd
          aria-hidden
          className="ml-auto shrink-0 font-normal text-fg-muted text-xs"
        >
          {shortcut}
        </kbd>
      )}
      {selected && <Icon className="ml-auto" name="check" />}
    </ToolbarPopoverButton>
  );
}

export function ToolbarPopoverGroup({
  label,
  children,
  ...props
}: React.ComponentProps<'section'> & { label: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="first:[&_h3]:pt-1" {...props}>
      <h3
        className="px-2 pt-3 pb-1.5 font-medium text-fg-muted text-xs leading-4"
        id={id}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}
