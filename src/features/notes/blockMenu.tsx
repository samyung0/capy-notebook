import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuAnchor,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/DropdownMenu';
import type { IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';
import { EditorIcon } from './EditorIcon';

// The block menu takes the editor popovers' look (ToolbarPopoverContent and
// ToolbarPopoverItem: the All blocks menu), not the app's menus.
export const BLOCK_MENU_CONTENT =
  'w-auto min-w-48 rounded-lg px-1 py-1.5 font-medium leading-(--body-line-height)';
export const MENU_ROW =
  'h-7.5 gap-2 rounded-lg px-2 py-0 font-medium [&_svg]:-translate-y-px';

export function BlockMenuItem({
  disabled,
  icon,
  label,
  onSelect,
}: {
  disabled?: boolean;
  icon?: IconName;
  label: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      className={MENU_ROW}
      disabled={disabled}
      onSelect={onSelect}
    >
      {icon && <EditorIcon name={icon} />}
      {label}
    </DropdownMenuItem>
  );
}

/** A table row's or column's hover pill (Epo 2026-11-10, mock T2): a press
 * opens its menu beside it. Stays shown while its menu is open. A note's
 * table and a question's table block share it. */
export function TableHandle({
  children,
  className,
  handleProps,
  handleRef,
  icon,
  label,
  side,
}: {
  children: React.ReactNode;
  className: string;
  /** The row pill also drags its row: a note's table by `handleRef`, a
   * question's table by native drag props. */
  handleProps?: React.ComponentProps<'button'>;
  handleRef?: React.Ref<HTMLButtonElement>;
  icon: IconName;
  label: string;
  side: 'bottom' | 'right';
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuAnchor asChild>
        <button
          {...handleProps}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={label}
          className={cn(
            'absolute z-40 flex items-center justify-center rounded-full border border-line bg-surface text-fg-muted opacity-0 outline-none transition-opacity hover:bg-surface-hover-bg hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-action',
            open && 'opacity-100',
            className
          )}
          contentEditable={false}
          data-plate-prevent-deselect
          onClick={() => setOpen(true)}
          ref={handleRef}
          title={label}
          type="button"
        >
          <EditorIcon className="size-3.5" name={icon} />
        </button>
      </DropdownMenuAnchor>
      {open && (
        <DropdownMenuContent
          align="start"
          className={BLOCK_MENU_CONTENT}
          data-plate-prevent-deselect
          onCloseAutoFocus={(event) => event.preventDefault()}
          side={side}
          sideOffset={4}
        >
          {children}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
