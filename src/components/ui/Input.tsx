import { cva, type VariantProps } from 'class-variance-authority';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';
import { IconButton, type IconButtonProps } from './IconButton';

const inputContainerVariants = cva(
  'has-[input[aria-invalid=true]]:motion-error-shake flex items-center gap-2 outline-none transition-none duration-150 file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-fg file:text-sm has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:bg-field-disabled',
  {
    compoundVariants: [
      {
        className: 'rounded-none',
        size: 'sm',
        variant: 'underline',
      },
      {
        className: 'rounded-none',
        size: 'md',
        variant: 'underline',
      },
      {
        className: 'rounded-none',
        size: 'lg',
        variant: 'underline',
      },
    ],
    defaultVariants: {
      size: 'md',
      variant: 'light',
    },
    variants: {
      size: {
        lg: 'rounded-card-lg px-4.5 py-0',
        // Same heights as Button md; one h-* override still replaces it.
        md: 'h-(--input-h) rounded-input px-3.5 py-0 [--input-h:--spacing(10)] sm:[--input-h:--spacing(11)]',
        sm: 'rounded-input px-2.5 py-0 text-xs',
      },
      variant: {
        light:
          'border border-line bg-field focus-within:border-action-accent has-[input[aria-invalid=true]]:border-solid-error',
        transparent: '',
        underline:
          'border-line border-b focus-within:border-action-accent has-[input[aria-invalid=true]]:border-solid-error',
      },
    },
  }
);

const inputVariants = cva(
  'min-w-0 flex-1 border-none bg-transparent outline-none placeholder:text-placeholder disabled:bg-field-disabled disabled:text-fg-muted',
  {
    defaultVariants: {
      size: 'md',
    },
    variants: {
      size: {
        lg: 'py-3.5',
        md: 'self-stretch py-0',
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
  actionLabel?: string;
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
  actionLabel,
}: {
  name: IconName;
  onClick?: () => void;
  actionVariant?: IconButtonProps['variant'];
  actionSize?: IconButtonProps['size'];
  actionClassName?: string;
  actionLabel?: string;
}) => (
  <IconButton
    className={actionClassName}
    icon={name}
    label={actionLabel}
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
  actionLabel,
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
          actionLabel={actionLabel}
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
          actionLabel={actionLabel}
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
      className={cn('motion-error-in t-body text-solid-error', className)}
      data-slot="field-error"
      role="alert"
      {...props}
    >
      {content}
    </div>
  );
}

export interface CountLimit {
  /** First count that shows; 90% of `max` by default. */
  from?: number;
  max: number;
  value: number;
}

/**
 * "72/80" once the count nears its limit, in the error colour at or over it.
 * Limits are soft: the field's own validation refuses values over `max`.
 */
export function CharCount({
  value,
  max,
  from = Math.ceil(max * 0.9),
  className,
}: CountLimit & { className?: string }) {
  if (value < from) return null;
  return (
    <span
      className={cn(
        't-meta whitespace-nowrap font-normal tabular-nums',
        value >= max ? 'text-solid-error' : 'text-fg-muted',
        className
      )}
    >
      {value}/{max}
    </span>
  );
}

export function InputTitle({
  className,
  children,
  required,
  count,
  ...props
}: React.ComponentProps<'div'> & {
  required?: boolean;
  /** Character (or item) count shown at the right end of the title row. */
  count?: CountLimit;
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
      {count && <CharCount className="ml-auto" {...count} />}
    </div>
  );
}

export function InputField({
  id,
  label,
  trailing,
  count,
  children,
  error,
}: {
  id: string;
  label: string;
  trailing?: React.ReactNode;
  count?: CountLimit;
  children: React.ReactNode;
  error?: { message?: string };
}) {
  return (
    <label className="mb-3 flex flex-col gap-1.5" htmlFor={id}>
      {children}
      <span className="order-first flex items-baseline justify-between">
        <InputTitle className="flex-1" count={count}>
          {label}
        </InputTitle>
        {trailing}
      </span>
      {error && <InputError errors={[error]} />}
    </label>
  );
}
