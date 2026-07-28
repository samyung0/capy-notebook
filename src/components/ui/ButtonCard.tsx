import { cn } from "@/lib/cn";
import { Button, ButtonProps } from "./Button";
import { Icon, IconName } from "./Icon";
import { ReactNode } from "react";

export function ButtonCard({
  className,
  buttonText,
  size = "lg",
  flex = "col",
  variant = "outline",
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
    <Button asChild size={size} variant={variant}>
      <button
        className={cn(
          "flex max-h-22 min-w-30 items-center justify-center transition-[transform,box-shadow] hover:-translate-y-0.5 hover:bg-initial hover:shadow-card",
          flex === 'col' && 'flex-col gap-2',
          flex === 'row' && 'flex-row gap-2.5',
          className,
        )}
        type="button"
        {...rest}
      >
        {icon && <Icon name={icon} size={22} className="size-5.5" />}
        {componentBeforeText}
        <span className="font-semibold tracking-wide">{buttonText}</span>
        {componentAfterText}
      </button>
    </Button>
  );
}
