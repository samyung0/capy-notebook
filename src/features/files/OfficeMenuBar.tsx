import { type ReactNode, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/Icon';
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/Menubar';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { TablePicker } from '@/features/notes/toolbar/ToolbarTableMenu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { FileModeControl } from './FileModeControl';
import {
  FileActionsTarget,
  FileHeaderTarget,
  FileMenuTarget,
} from './fileModeContext';
import {
  ariaKeyShortcut,
  type OfficeHeaderAction,
  type OfficeMenu,
  type OfficeMenuEntry,
  officeItemAction,
} from './officeMenus';
import type { useOfficeRuntime } from './useOfficeRuntime';

interface Handlers {
  onCommand: (id: string, value?: string) => void;
  /** A `pick` item's file from Capy's picker. */
  onFile: (id: string, file: File) => void;
  /** Called as an item is picked, before the menu closes. */
  onPick: () => void;
  /** The table size grid is no menu item: picking a size closes the menu. */
  onPickAndClose: () => void;
}

/** Opens the browser's file picker from the menu click's user activation. */
function pickFile(accept: string, onFile: (file: File) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      if (file) onFile(file);
    },
    { once: true }
  );
  input.click();
}

/**
 * Puts the Office runtime's menu bar and header actions into the file
 * header's slots. Nothing renders until the runtime sends its menus.
 */
export function OfficeHeaderSlots({
  menus,
  onCommand,
  onFile,
  onPicked,
}: Omit<Handlers, 'onPick' | 'onPickAndClose'> & {
  menus: { menus: OfficeMenu[]; actions: OfficeHeaderAction[] } | null;
  /** Where focus goes after a picked item: the document, not the trigger. */
  onPicked: () => void;
}) {
  const menuTarget = useContext(FileMenuTarget);
  const actionsTarget = useContext(FileActionsTarget);
  // Below sm the right cluster has no room for a label (PPTX Present runs
  // under the mode toggle): the action shows its icon, named by its tooltip.
  const labelled = useMediaQuery('(min-width: 640px)');
  if (!menus) return null;
  return (
    <>
      {menuTarget &&
        createPortal(
          <OfficeMenuBar
            menus={menus.menus}
            onCommand={onCommand}
            onFile={onFile}
            onPicked={onPicked}
          />,
          menuTarget
        )}
      {actionsTarget &&
        createPortal(
          menus.actions.map((action) => (
            <HeaderAction
              action={action}
              key={action.id}
              labelled={labelled}
              onCommand={onCommand}
            />
          )),
          actionsTarget
        )}
    </>
  );
}

/**
 * A header action; with `items`, a split button (PPTX Present, as Google
 * Slides' Slideshow ▾): the main part runs the action, the arrow lists the rest.
 */
function HeaderAction({
  action,
  labelled,
  onCommand,
}: {
  action: OfficeHeaderAction;
  labelled: boolean;
  onCommand: (id: string) => void;
}) {
  const split = !!action.items?.length;
  const main = labelled ? (
    <Button
      className={cn('h-8 px-2.5 font-medium', split && 'rounded-r-none')}
      iconLeft={action.icon}
      onClick={() => onCommand(action.id)}
      size="sm"
      variant="ghost-hover"
    >
      {action.label}
    </Button>
  ) : (
    <ButtonTooltip label={action.label}>
      <Button
        aria-label={action.label}
        className={cn('size-8 px-0', split && 'rounded-r-none')}
        iconLeft={action.icon}
        onClick={() => onCommand(action.id)}
        size="sm"
        variant="ghost-hover"
      />
    </ButtonTooltip>
  );
  if (!split) return <span className="mr-1 inline-flex">{main}</span>;
  return (
    <div className="mr-1 flex items-center" role="group">
      {main}
      <span aria-hidden className="h-4 w-px bg-divider" />
      <DropdownMenu modal={false}>
        <ButtonTooltip label={m.files_office_present_options()}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={m.files_office_present_options()}
              className="h-8 w-[22px] rounded-l-none px-0 data-[state=open]:bg-surface-hover-bg"
              size="sm"
              variant="ghost-hover"
            >
              <Icon name="chevronDown" size={14} />
            </Button>
          </DropdownMenuTrigger>
        </ButtonTooltip>
        {/* The menu bar's look (OfficeMenuBar below). */}
        <DropdownMenuContent
          align="end"
          className="min-w-48 rounded-lg px-1 py-1.5 font-medium text-sm leading-(--body-line-height)"
        >
          {action.items?.map((entry, index) =>
            entry.kind === 'separator' ? (
              <DropdownMenuSeparator key={`separator-${index}`} />
            ) : entry.kind === 'item' ? (
              <DropdownMenuItem
                className="h-7 rounded-lg py-0 leading-(--body-line-height) focus:bg-surface-hover-bg/80 data-[highlighted]:bg-surface-hover-bg/80 [&_svg]:-translate-y-px"
                disabled={entry.disabled}
                key={entry.id}
                onSelect={() => onCommand(entry.id)}
              >
                {entry.icon ? (
                  <Icon name={entry.icon} />
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}
                {entry.label}
              </DropdownMenuItem>
            ) : null
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function OfficeMenuBar({
  menus,
  onPicked,
  ...handlers
}: Omit<Handlers, 'onPick' | 'onPickAndClose'> & {
  menus: OfficeMenu[];
  onPicked: () => void;
}) {
  // Narrow headers scroll the menus sideways, as Capy's toolbar rows do.
  const ref = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(ref);
  // A picked item hands focus to the document; Escape returns it to the menu.
  const picked = useRef(false);
  const [open, setOpen] = useState('');
  const onPick = () => {
    picked.current = true;
  };
  const onPickAndClose = () => {
    picked.current = true;
    setOpen('');
  };
  return (
    <Menubar
      aria-label={m.files_office_menu_bar()}
      className="scroll-fade-x -ml-0.5 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onValueChange={setOpen}
      ref={ref}
      value={open}
    >
      {menus.map((menu) => (
        <MenubarMenu key={menu.id} value={menu.id}>
          <MenubarTrigger className="flex h-6 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-button px-2 font-medium text-fg text-sm leading-none outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-surface-hover-bg">
            {menu.label}
          </MenubarTrigger>
          {/* The note toolbar's popover (ToolbarPopoverContent). */}
          <MenubarContent
            align="start"
            className="min-w-56 rounded-lg px-1 py-1.5 font-medium text-sm leading-(--body-line-height)"
            onCloseAutoFocus={(event) => {
              if (!picked.current) return;
              picked.current = false;
              event.preventDefault();
              onPicked();
            }}
          >
            <Entries
              entries={menu.items}
              onPick={onPick}
              onPickAndClose={onPickAndClose}
              {...handlers}
            />
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}

/** Rows as ToolbarPopoverItem: icon, label, shortcut, then the tick. */
function Entries({
  entries,
  ...handlers
}: Handlers & { entries: OfficeMenuEntry[] }) {
  const { onCommand, onFile, onPick, onPickAndClose } = handlers;
  // Labels line up when any row draws an icon.
  const column = entries.some(
    (entry) => (entry.kind === 'item' || entry.kind === 'submenu') && entry.icon
  );
  return entries.map((entry, index) => {
    if (entry.kind === 'separator')
      return <MenubarSeparator className="mx-0" key={`separator-${index}`} />;
    if (entry.kind === 'grid')
      return (
        <TablePicker
          key={entry.id}
          onInsert={(rows, cols) => {
            onCommand(entry.id, `${rows}x${cols}`);
            onPickAndClose();
          }}
        />
      );
    if (entry.kind === 'submenu')
      return (
        <MenubarSub key={entry.id}>
          <MenubarSubTrigger
            className="h-7 rounded-lg py-0 leading-(--body-line-height) focus:bg-surface-hover-bg/80 data-[highlighted]:bg-surface-hover-bg/80 data-[state=open]:bg-surface-hover-bg/80 [&_svg]:-translate-y-px"
            disabled={entry.disabled}
          >
            <Lead column={column} icon={entry.icon} />
            <span className="min-w-0 flex-1">{entry.label}</span>
          </MenubarSubTrigger>
          <MenubarSubContent className="min-w-48 rounded-lg px-1 py-1.5 font-medium text-sm leading-(--body-line-height)">
            <Entries entries={entry.items} {...handlers} />
          </MenubarSubContent>
        </MenubarSub>
      );
    const checkable = entry.checked !== undefined;
    const action = officeItemAction(entry);
    return (
      <MenubarItem
        // A checkbox item draws its tick at the start and the note toolbar's
        // popovers at the end, so ticked rows are items with the checkbox
        // role. Every row names its role: undefined would drop menuitem.
        aria-checked={checkable ? entry.checked : undefined}
        aria-keyshortcuts={
          entry.shortcut ? ariaKeyShortcut(entry.shortcut) : undefined
        }
        className="h-7 rounded-lg py-0 leading-(--body-line-height) focus:bg-surface-hover-bg/80 data-[highlighted]:bg-surface-hover-bg/80 [&_svg]:-translate-y-px"
        disabled={entry.disabled}
        key={entry.id}
        onSelect={() => {
          onPick();
          if (action.kind === 'pick')
            pickFile(action.accept, (file) => onFile(entry.id, file));
          else onCommand(entry.id);
        }}
        role={
          checkable
            ? entry.radio
              ? 'menuitemradio'
              : 'menuitemcheckbox'
            : 'menuitem'
        }
      >
        <Lead column={column} icon={entry.icon} />
        <span className="min-w-0 flex-1">{entry.label}</span>
        {entry.shortcut && (
          <kbd
            aria-hidden
            className="shrink-0 font-normal text-fg-muted text-xs"
          >
            {entry.shortcut}
          </kbd>
        )}
        {entry.checked && <Icon name="check" />}
      </MenubarItem>
    );
  });
}

function Lead({ column, icon }: { column: boolean; icon?: IconName }) {
  if (icon) return <Icon name={icon} />;
  return column ? <span aria-hidden className="size-4 shrink-0" /> : null;
}

/**
 * An Office view's part of the file header: the runtime's menus and header
 * actions, and the mode toggle. Without a file header to portal into, a row
 * of its own carries `label` and the toggle.
 */
export function OfficeHeader({
  canEdit,
  label,
  runtime,
}: {
  canEdit: boolean;
  label: ReactNode;
  runtime: Pick<
    ReturnType<typeof useOfficeRuntime>,
    | 'analysis'
    | 'handoff'
    | 'iframeRef'
    | 'menus'
    | 'mode'
    | 'ready'
    | 'replaced'
    | 'runMenuCommand'
    | 'saving'
    | 'sendMenuFile'
    | 'setRuntimeMode'
  >;
}) {
  const headerTarget = useContext(FileHeaderTarget);
  const control = (
    <FileModeControl
      canEdit={canEdit}
      disabled={
        runtime.mode === 'view'
          ? !runtime.analysis
          : !runtime.ready ||
            runtime.saving ||
            runtime.handoff ||
            runtime.replaced
      }
      mode={runtime.mode}
      onChange={runtime.setRuntimeMode}
    />
  );
  return (
    <>
      <OfficeHeaderSlots
        menus={runtime.menus}
        onCommand={runtime.runMenuCommand}
        onFile={runtime.sendMenuFile}
        onPicked={() => {
          // The menu closes after its exit animation: by then a click may
          // already have put the focus into the document, which it keeps.
          const frame = runtime.iframeRef.current;
          if (frame && document.activeElement !== frame) frame.focus();
        }}
      />
      {headerTarget ? (
        control
      ) : (
        <div className="flex min-h-10 items-center gap-2 border-line border-b px-2">
          <span className="t-meta flex-1 text-fg-muted">{label}</span>
          {control}
        </div>
      )}
    </>
  );
}
