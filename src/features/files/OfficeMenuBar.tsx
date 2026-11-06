import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  type FileBannerStrip,
  useBannerOutlet,
} from '@/components/banners/FileBanner';
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
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useHorizontalWheelScroll } from '@/lib/useHorizontalWheelScroll';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { TablerIcon } from '@/office-runtime/TablerIcon';
import {
  arrowBackUp,
  arrowForwardUp,
  chevronDown,
} from '@/office-runtime/tablerGlyphs';
import { FileModeControl } from './FileModeControl';
import {
  FileActionsTarget,
  FileHeaderTarget,
  FileMenuShown,
  FileMenuTarget,
} from './fileModeContext';
import {
  ariaKeyShortcut,
  OFFICE_RIBBON_COMMANDS,
  type OfficeHeaderAction,
  type OfficeMenu,
  type OfficeMenuEntry,
  type OfficeRibbon,
} from './officeMenus';
import type { useOfficeRuntime } from './useOfficeRuntime';

interface Handlers {
  onCommand: (id: string, value?: string) => void;
  /** Called as an item is picked, before the menu closes. */
  onPick: () => void;
}

/**
 * Puts the Office runtime's menu bar and header actions into the file
 * header's slots. Nothing renders until the runtime sends its menus.
 */
export function OfficeHeaderSlots({
  menus,
  onCommand,
  onPicked,
}: Omit<Handlers, 'onPick'> & {
  menus: {
    actions: OfficeHeaderAction[];
    menus: OfficeMenu[];
    ribbon?: OfficeRibbon;
  } | null;
  /** Where focus goes after a picked item: the document, not the trigger. */
  onPicked: () => void;
}) {
  const menuTarget = useContext(FileMenuTarget);
  const actionsTarget = useContext(FileActionsTarget);
  // Below sm the right cluster has no room for a label (PPTX Present runs
  // under the mode toggle): the action shows its icon, named by its tooltip.
  const labelled = useMediaQuery('(min-width: 640px)');
  // The first menus mean the file is visible: the header gets its second row
  // and keeps it while the frame reloads for a mode switch (Epo 2026-10-20).
  const setMenuShown = useContext(FileMenuShown);
  const shown = !!menus && !!menuTarget;
  useEffect(() => {
    if (shown) setMenuShown?.(true);
  }, [setMenuShown, shown]);
  useEffect(() => () => setMenuShown?.(false), [setMenuShown]);
  if (!menus) return null;
  return (
    <>
      {menuTarget &&
        createPortal(
          <div className="flex min-w-0 items-center">
            {menus.ribbon && (
              <HistoryButtons
                onCommand={onCommand}
                onPicked={onPicked}
                ribbon={menus.ribbon}
              />
            )}
            {/* With tabs after it, File keeps its width and only they scroll. */}
            <div className={cn('flex min-w-0', menus.ribbon && 'shrink-0')}>
              <OfficeMenuBar
                menus={menus.menus}
                onCommand={onCommand}
                onPicked={onPicked}
              />
            </div>
            {menus.ribbon && (
              <RibbonTabs
                onCommand={onCommand}
                onPicked={onPicked}
                ribbon={menus.ribbon}
              />
            )}
          </div>,
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

const TAB_LINE_BUTTON =
  'flex h-6 shrink-0 cursor-pointer items-center justify-center rounded-button outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action disabled:pointer-events-none disabled:opacity-40';

/** A press keeps the document's focus: the tab line is the document's chrome. */
function keepFrameFocus(event: { preventDefault: () => void }) {
  event.preventDefault();
}

/** Undo and Redo at the tab line's left end, as Office's Quick Access Toolbar. */
function HistoryButtons({
  onCommand,
  onPicked,
  ribbon,
}: {
  onCommand: (id: string) => void;
  onPicked: () => void;
  ribbon: OfficeRibbon;
}) {
  const button = (
    item: OfficeRibbon['undo'],
    glyph: typeof arrowBackUp | typeof arrowForwardUp
  ) => (
    <ButtonTooltip
      label={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
    >
      <button
        aria-keyshortcuts={
          item.shortcut ? ariaKeyShortcut(item.shortcut) : undefined
        }
        aria-label={item.label}
        className={cn(TAB_LINE_BUTTON, 'w-7 text-fg')}
        disabled={item.disabled}
        onClick={() => {
          onCommand(item.id);
          onPicked();
        }}
        onMouseDown={keepFrameFocus}
        type="button"
      >
        <TablerIcon glyph={glyph} />
      </button>
    </ButtonTooltip>
  );
  return (
    <>
      {button(ribbon.undo, arrowBackUp)}
      {button(ribbon.redo, arrowForwardUp)}
      <span
        aria-hidden
        className="mr-1.5 ml-1 h-3.5 w-px shrink-0 bg-divider"
      />
    </>
  );
}

/**
 * The ribbon's tabs after File. The tab state is the runtime's: a click asks,
 * and `ribbon` comes back. A double click collapses, as in Office.
 */
function RibbonTabs({
  onCommand,
  onPicked,
  ribbon,
}: {
  onCommand: (id: string) => void;
  onPicked: () => void;
  ribbon: OfficeRibbon;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(ref);
  const moveFocus = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const tabs = [
      ...(ref.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ];
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    tabs[(at + step + tabs.length) % tabs.length]?.focus();
  };
  return (
    <div className="flex min-w-0 items-center">
      <div
        aria-label={m.files_office_ribbon_tabs()}
        className="scroll-fade-x flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={moveFocus}
        ref={ref}
        role="tablist"
      >
        {ribbon.tabs.map((tab) => {
          const current = ribbon.tab === tab.id;
          return (
            <button
              aria-selected={current}
              className={cn(
                TAB_LINE_BUTTON,
                'relative whitespace-nowrap px-2 font-medium text-sm leading-none',
                current
                  ? 'font-bold text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-action'
                  : 'text-fg-muted'
              )}
              data-testid={`office-tab-${tab.id}`}
              key={tab.id}
              onClick={() => {
                onCommand(`${OFFICE_RIBBON_COMMANDS.tab}${tab.id}`);
                onPicked();
              }}
              onDoubleClick={() => onCommand(OFFICE_RIBBON_COMMANDS.collapse)}
              onMouseDown={keepFrameFocus}
              role="tab"
              tabIndex={
                current || (ribbon.tab === null && tab === ribbon.tabs[0])
                  ? 0
                  : -1
              }
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {ribbon.collapsed && (
        <ButtonTooltip label={m.files_office_ribbon_expand()}>
          <button
            aria-label={m.files_office_ribbon_expand()}
            className={cn(TAB_LINE_BUTTON, 'ml-1 w-7 text-fg-muted')}
            data-testid="office-ribbon-expand"
            onClick={() => {
              onCommand(OFFICE_RIBBON_COMMANDS.collapse);
              onPicked();
            }}
            onMouseDown={keepFrameFocus}
            type="button"
          >
            <TablerIcon glyph={chevronDown} size={16} />
          </button>
        </ButtonTooltip>
      )}
    </div>
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
}: Omit<Handlers, 'onPick'> & {
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
          <MenubarTrigger className="flex h-6 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-button px-2 font-medium text-fg text-sm leading-none outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action data-[state=open]:bg-surface-hover-bg">
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
            <Entries entries={menu.items} onPick={onPick} {...handlers} />
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
  const { onCommand, onPick } = handlers;
  // Labels line up when any row draws an icon.
  const column = entries.some(
    (entry) => (entry.kind === 'item' || entry.kind === 'submenu') && entry.icon
  );
  return entries.map((entry, index) => {
    if (entry.kind === 'separator')
      return <MenubarSeparator className="mx-0" key={`separator-${index}`} />;
    if (entry.kind === 'grid') return null;
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
          onCommand(entry.id);
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
    | 'setRuntimeMode'
    | 'showFrameBanner'
    | 'sizeLimited'
  >;
}) {
  const headerTarget = useContext(FileHeaderTarget);
  // Under the ribbon, which is in the frame, Office's message bar (Q566).
  const { showFrameBanner } = runtime;
  const hasRibbon = !!runtime.menus?.ribbon;
  const toFrame = useCallback(
    (strip: FileBannerStrip | null) =>
      showFrameBanner(
        strip && {
          actions: strip.actions.map(({ disabled, label }) => ({
            disabled,
            label,
          })),
          closeable: strip.closeable,
          inline: strip.inline,
          kind: strip.kind,
          message: strip.message,
          testId: strip.testId,
          tone: strip.tone,
        },
        strip &&
          ((action) =>
            action === 'close'
              ? strip.onClose()
              : strip.actions[action]?.onClick())
      ),
    [showFrameBanner]
  );
  useBannerOutlet(hasRibbon && headerTarget ? toFrame : null);
  const control = (
    <FileModeControl
      canEdit={canEdit}
      disabled={
        runtime.mode === 'view'
          ? !runtime.analysis || runtime.sizeLimited
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
