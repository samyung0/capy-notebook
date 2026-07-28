import { cva, type VariantProps } from 'class-variance-authority';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';
import { IconButton, type IconButtonProps } from './IconButton';

const inputContainerVariants = cva(
  "flex items-center gap-2 outline-none transition-[colors,border] duration-150 file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-fg file:text-sm disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    compoundVariants: [
      {
        className: "rounded-none",
        size: "sm",
        variant: "underline",
      },
      {
        className: "rounded-none",
        size: "md",
        variant: "underline",
      },
      {
        className: "rounded-none",
        size: "lg",
        variant: "underline",
      },
    ],
    defaultVariants: {
      size: "md",
      variant: "light",
    },
    variants: {
      size: {
        lg: "rounded-card-lg px-4.5 py-0",
        md: "rounded-input px-3.5 py-0",
        sm: "rounded-input px-2.5 py-0 text-xs",
      },
      variant: {
        light:
          "border border-line bg-surface focus-within:border-line-strong has-[input[aria-invalid=true]]:border-2 has-[input[aria-invalid=true]]:border-solid-error",
        transparent: "",
        underline:
          "border-line border-b focus-within:border-line-strong has-[input[aria-invalid=true]]:border-solid-error has-[input[aria-invalid=true]]:border-b-2",
      },
    },
  },
);

const inputVariants = cva(
  'min-w-0 flex-1 border-none bg-transparent py-2.5 outline-none placeholder:text-placeholder',
  {
    defaultVariants: {
      size: 'md',
    },
    variants: {
      size: {
        lg: 'py-3.5',
        md: 'py-2.5',
        sm: 'pt-2 pb-0.5',
      },
    },
  }
);

export interface InputProps
  extends Omit<React.ComponentProps<'input'>, 'size'>,
    VariantProps<typeof inputContainerVariants> {
  actionCallback?: () => void;
  actionClassName?: string;
  actionIcon?: IconName;
  actionShowIcon?: boolean;
  actionSide?: 'left' | 'right';
  actionSize?: IconButtonProps['size'];
  actionVariant?: IconButtonProps['variant'];
  leftIcon?: IconName;
  rightIcon?: IconName;
  wrapperClassName?: string;
}

const InlineIcon = ({ name }: { name: IconName }) => (
  <Icon className={cn('size-4.5 text-fg-muted')} name={name} />
);

const InlineAction = ({
  name,
  onClick,
  actionVariant,
  actionSize,
  actionClassName,
}: {
  name: IconName;
  onClick?: () => void;
  actionVariant?: IconButtonProps['variant'];
  actionSize?: IconButtonProps['size'];
  actionClassName?: string;
}) => (
  <IconButton
    className={actionClassName}
    icon={name}
    onClick={onClick}
    size={actionSize}
    variant={actionVariant}
  />
);

export function Input({
  leftIcon,
  rightIcon,
  wrapperClassName,
  actionIcon,
  actionSide = 'right',
  actionCallback,
  actionShowIcon = true,
  className,
  variant,
  size,
  actionVariant = 'ghost-hover',
  actionSize = 'sm',
  actionClassName,
  ...rest
}: InputProps) {
  return (
    <div
      className={cn(
        inputContainerVariants({ size, variant }),
        actionIcon && actionSide === 'right' && 'pr-2',
        actionIcon && actionSide === 'left' && 'pl-2',
        wrapperClassName
      )}
    >
      {leftIcon && <InlineIcon name={leftIcon} />}
      {actionIcon && actionShowIcon && actionSide === 'left' && (
        <InlineAction
          actionClassName={actionClassName}
          actionSize={actionSize}
          actionVariant={actionVariant}
          name={actionIcon}
          onClick={actionCallback}
        />
      )}
      <input className={cn(inputVariants({ size }), className)} {...rest} />
      {rightIcon && <InlineIcon name={rightIcon} />}
      {actionIcon && actionShowIcon && actionSide === 'right' && (
        <InlineAction
          actionClassName={actionClassName}
          actionSize={actionSize}
          actionVariant={actionVariant}
          name={actionIcon}
          onClick={actionCallback}
        />
      )}
    </div>
  );
}

export function InputError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }
    if (!errors?.length) {
      return null;
    }
    const uniqueErrors = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ];
    if (uniqueErrors.length === 1) {
      return uniqueErrors[0]?.message;
    }
    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map(
          (error, index) =>
            error?.message && <li key={index}>{error.message}</li>
        )}
      </ul>
    );
  }, [children, errors]);
  if (!content) {
    return null;
  }
  return (
    <div
      className={cn('mt-1.5 text-solid-error', className)}
      data-slot="field-error"
      role="alert"
      {...props}
    >
      {content}
    </div>
  );
}

export function InputTitle({
  className,
  children,
  required,
  ...props
}: React.ComponentProps<'div'> & {
  required?: boolean;
}) {
  return (
    <div
      className={cn(
        't-subtitle flex items-center gap-1 font-medium',
        className
      )}
      {...props}
    >
      <div>{children}</div>
      {required && <div className="text-solid-error">*</div>}
    </div>
  );
}
