import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from './Button';
import { Icon, type IconName } from './Icon';

export function ButtonCard({
  className,
  buttonText,
  flex = 'col',
  variant = 'outline',
  icon,
  componentAfterText,
  componentBeforeText,
  ...rest
}: ButtonProps & {
  icon?: IconName;
  flex?: 'row' | 'col';
  buttonText?: string;
  componentBeforeText?: ReactNode;
  componentAfterText?: ReactNode;
}) {
  return (
    <Button asChild size={'lg'} variant={variant}>
      <button
        className={cn(
          'flex h-auto max-h-22 min-w-30 items-center justify-center rounded-card! px-6.5 py-5 transition-[transform,box-shadow] hover:-translate-y-0.5 hover:bg-initial hover:shadow-card',
          flex === 'col' && 'flex-col gap-2',
          flex === 'row' && 'flex-row gap-2.5',
          className
        )}
        type="button"
        {...rest}
      >
        {icon && <Icon className="size-5.5" name={icon} size={22} />}
        {componentBeforeText}
        <span className="font-semibold tracking-wide">{buttonText}</span>
        {componentAfterText}
      </button>
    </Button>
  );
}
