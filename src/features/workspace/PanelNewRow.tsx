import type { ComponentProps } from 'react';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';

/** A panel's leading action under its search (New chat, New file or
 * chapter): a nav row like the app sidebar's, icon and label with a hover
 * fill only. With `menu` it opens that dropdown instead of acting. */
export function PanelNewRow({
  icon,
  label,
  menu,
  onClick,
}: {
  icon: IconName;
  label: string;
} & (
  | { menu: MenuItem[]; onClick?: never }
  | { menu?: never; onClick: () => void }
)) {
  const row = <RowButton icon={icon} label={label} onClick={onClick} />;
  return (
    // A column so the menu trigger's inline anchor stretches to full width.
    <div className="flex shrink-0 flex-col px-2.5 pt-1">
      {menu ? <Menu align="start" items={menu} trigger={row} /> : row}
    </div>
  );
}

// Spreads the menu trigger's props and ref onto the button.
function RowButton({
  icon,
  label,
  className,
  ...props
}: ComponentProps<'button'> & { icon: IconName; label: string }) {
  return (
    <button
      className={cn(
        BASE_BUTTON_STYLE,
        'flex h-fit w-full justify-start gap-2 px-2 py-1.5 font-medium text-fg leading-(--body-line-height) hover:bg-surface-hover-bg active:-rotate-1',
        className
      )}
      type="button"
      {...props}
    >
      {/* Sized and spaced like the file rows below, so the labels line up. */}
      <Icon className="shrink-0" name={icon} size={15} />
      <span className="translate-y-px font-semibold">{label}</span>
    </button>
  );
}
