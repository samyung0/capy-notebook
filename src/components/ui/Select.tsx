import { cva, type VariantProps } from 'class-variance-authority';
import { Select as SelectPrimitive } from 'radix-ui';
import type * as React from 'react';

import { cn } from '@/lib/cn';
import { Spinner } from './feedback';
import { Icon } from './Icon';

function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      className={cn('scroll-my-1 p-1', className)}
      data-slot="select-group"
      {...props}
    />
  );
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

const selectTriggerVariants = cva(
  'flex w-full items-center justify-between gap-2 bg-surface text-left text-fg hover:border-line-strong focus-visible:border-line-strong disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:border-line-strong',
  {
    defaultVariants: {
      size: 'md',
      variant: 'border',
    },
    variants: {
      size: {
        md: 'px-3.25 py-2.5',
        sm: 'px-2.5 pt-2 pb-0.5 text-xs',
      },
      variant: {
        border: 'rounded-input border border-line',
        ghost: 'border-none',
        'ghost-hover': 'rounded-input bg-surface hover:bg-surface-hover-bg',
        underline: 'border-line border-b',
      },
    },
  }
);

function SelectTrigger({
  className,
  size = 'md',
  variant = 'border',
  loading = false,
  children,
  showDownIcon = true,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants> & {
    loading?: boolean;
    showDownIcon?: boolean;
  }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size, variant }), className)}
      data-loading={loading || undefined}
      data-size={size}
      data-slot="select-trigger"
      data-variant={variant}
      {...props}
    >
      {children}
      {loading ? (
        <Spinner className="size-4 shrink-0 text-fg-muted" />
      ) : showDownIcon ? (
        <SelectPrimitive.Icon asChild>
          {/* TODO: rotate to up when active */}
          <Icon
            className="size-4 text-fg-muted transition-transform duration-200 data-[state=open]:rotate-180"
            name="chevronDown"
          />
        </SelectPrimitive.Icon>
      ) : null}
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  align = 'center',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        align={align}
        className={cn(
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=close]:fade-out-0 data-[state=close]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 relative z-100 max-h-(--radix-select-content-available-height) min-w-36 origin-(--radix-select-content-transform-origin) overflow-y-auto overflow-x-hidden rounded-button border border-line bg-surface duration-100 data-[align-trigger=true]:animate-none data-[state=close]:animate-out data-[state=open]:animate-in',
          position === 'popper' &&
            'data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className
        )}
        data-align-trigger={position === 'item-aligned'}
        data-slot="select-content"
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'data-[position=popper]:h-(--radix-select-trigger-height) data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)',
            position === 'popper' && ''
          )}
          data-position={position}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('t-label px-1.5 py-1', className)}
      data-slot="select-label"
      {...props}
    />
  );
}

const selectItemVariants = cva(
  "relative flex w-full cursor-pointer select-none items-center gap-1.5 rounded-button bg-surface text-left font-medium text-fg outline-hidden transition-colors hover:bg-surface-hover-bg disabled:opacity-40 data-disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
  {
    defaultVariants: {
      size: 'md',
    },
    variants: {
      size: {
        md: 'px-3.25 py-2.5',
        sm: 'px-2.5 py-2 text-xs',
      },
    },
  }
);

function SelectItem({
  className,
  children,
  disabled,
  size = 'md',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item> &
  VariantProps<typeof selectItemVariants>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        selectItemVariants({ size }),
        disabled && 'opacity-50',
        className
      )}
      data-size={size}
      data-slot="select-item"
      disabled={disabled}
      {...props}
    >
      <div className="pointer-events-none absolute right-2 flex size-4 items-center justify-center font-medium">
        <SelectPrimitive.ItemIndicator>
          <Icon className="pointer-events-none" name="check" />
        </SelectPrimitive.ItemIndicator>
      </div>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn('pointer-events-none mx-3 my-1 h-px bg-line', className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      className={cn(
        "z-10 flex cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="select-scroll-up-button"
      {...props}
    >
      <Icon name="chevronUp" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      className={cn(
        "z-10 flex cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      data-slot="select-scroll-down-button"
      {...props}
    >
      <Icon name="chevronDown" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
