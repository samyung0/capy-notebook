import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { OfficeMenuEntry } from '@/features/files/officeMenus';
import { OFFICE_RIBBON_COMMANDS } from '@/features/files/officeMenus';
import { m } from '@/i18n';
import type {
  RibbonGroup as Group,
  RibbonCell,
  RibbonLayout,
} from './ribbonLayout';
import {
  findRibbonEntry,
  HOME_TAB,
  type RibbonContext,
  type RibbonStore,
} from './ribbonStore';
import { TablerIcon } from './TablerIcon';
import { check, chevronDown, chevronUp, pin, x } from './tablerGlyphs';

const BIG_ICON = 20;
const SMALL_ICON = 18;
const CHEVRON = 14;
const BIG_CHEVRON = 12;
/** An open list stays this far from the window's edges. */
const MENU_MARGIN = 8;
/** The table size grid, as Capy's note toolbar picks one. */
const GRID_SIZE = 8;

/**
 * A press in the ribbon keeps the editor's focus and selection. A menu entry's
 * command may move the focus itself (a comment box), so the release stays from
 * the DOCX toolbar's root, which would hand it back to the document.
 */
const PRESS = {
  onMouseDown: (event: MouseEvent) => event.preventDefault(),
  onMouseUp: (event: MouseEvent) => event.stopPropagation(),
};

/** What a cell needs of its ribbon: the commands' runner and glyphs. */
interface RibbonApi {
  glyphs: RibbonLayout['glyphs'];
  run: RibbonStore['run'];
}
type ItemEntry = Extract<OfficeMenuEntry, { kind: 'item' }>;
type MenuEntry = Extract<OfficeMenuEntry, { kind: 'submenu' }>;

/** Runs an item; a `pick` item opens the file picker from this click. */
function runItem(api: RibbonApi, entry: ItemEntry) {
  if (entry.pick !== 'image') {
    api.run(entry.id);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      if (file) api.run(entry.id, undefined, file);
    },
    { once: true }
  );
  input.click();
}

function Chevron({ size = CHEVRON }: { size?: number }) {
  return <TablerIcon glyph={chevronDown} size={size} />;
}

function title(entry: ItemEntry) {
  return entry.shortcut ? `${entry.label} (${entry.shortcut})` : entry.label;
}

function RibbonButton({
  big,
  entry,
  iconOnly,
  api,
}: {
  big?: boolean;
  entry: ItemEntry;
  iconOnly?: boolean;
  api: RibbonApi;
}) {
  const glyph = api.glyphs[entry.id];
  return (
    <button
      aria-label={entry.label}
      aria-pressed={entry.checked}
      className="office-ribbon__button"
      data-big={big || undefined}
      data-command={entry.id}
      data-icon-only={(iconOnly && !!glyph) || undefined}
      disabled={entry.disabled}
      onClick={() => runItem(api, entry)}
      {...PRESS}
      title={title(entry)}
      type="button"
    >
      {glyph && <TablerIcon glyph={glyph} size={big ? BIG_ICON : SMALL_ICON} />}
      {!(iconOnly && glyph) && <span>{entry.label}</span>}
    </button>
  );
}

/** A dropdown's rows; a nested submenu's items follow its label. */
function MenuRows({
  api,
  close,
  entries,
}: {
  api: RibbonApi;
  close: () => void;
  entries: readonly OfficeMenuEntry[];
}) {
  return entries.map((entry, index) => {
    if (entry.kind === 'separator')
      return (
        <hr
          className="office-ribbon__menu-separator"
          key={`separator-${index}`}
        />
      );
    if (entry.kind === 'grid')
      return <TableGrid api={api} close={close} id={entry.id} key={entry.id} />;
    if (entry.kind === 'submenu')
      return (
        <div key={entry.id} role="group">
          <div className="office-ribbon__menu-label">{entry.label}</div>
          <MenuRows api={api} close={close} entries={entry.items} />
        </div>
      );
    const glyph = api.glyphs[entry.id];
    return (
      <button
        aria-checked={entry.checked}
        className="office-ribbon__menu-item"
        data-command={entry.id}
        disabled={entry.disabled}
        key={entry.id}
        onClick={() => {
          runItem(api, entry);
          close();
        }}
        {...PRESS}
        role={
          entry.checked === undefined
            ? 'menuitem'
            : entry.radio
              ? 'menuitemradio'
              : 'menuitemcheckbox'
        }
        type="button"
      >
        {glyph && <TablerIcon glyph={glyph} size={SMALL_ICON} />}
        <span>{entry.label}</span>
        {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
        {entry.checked && <TablerIcon glyph={check} size={16} />}
      </button>
    );
  });
}

/** Capy's table size grid in the frame: hover a size, click to insert it. */
function TableGrid({
  api,
  close,
  id,
}: {
  api: RibbonApi;
  close: () => void;
  id: string;
}) {
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  return (
    <div className="office-ribbon__grid" role="grid">
      {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
        const rows = Math.floor(index / GRID_SIZE) + 1;
        const cols = (index % GRID_SIZE) + 1;
        return (
          <button
            aria-label={`${rows}x${cols}`}
            data-on={(rows <= size.rows && cols <= size.cols) || undefined}
            key={index}
            onClick={() => {
              api.run(id, `${rows}x${cols}`);
              close();
            }}
            onFocus={() => setSize({ cols, rows })}
            {...PRESS}
            onMouseEnter={() => setSize({ cols, rows })}
            role="gridcell"
            type="button"
          />
        );
      })}
      <div className="office-ribbon__grid-size">
        {size.rows ? `${size.rows} × ${size.cols}` : ' '}
      </div>
    </div>
  );
}

/** The ticked item a box shows, a nested list's included. */
function tickedLabel(entries: readonly OfficeMenuEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.checked) return entry.label;
    const found =
      entry.kind === 'submenu' ? tickedLabel(entry.items) : undefined;
    if (found) return found;
  }
}

/** A button that opens the entry's items, in the frame as its other popovers. */
function RibbonMenu({
  api,
  big,
  box,
  entry,
  iconOnly,
  split,
}: {
  api: RibbonApi;
  big?: boolean;
  box?: boolean;
  entry: MenuEntry;
  iconOnly?: boolean;
  /** The item a split's upper half runs. */
  split?: ItemEntry;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const viaKeyboard = useRef(false);
  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!(open && trigger.current && list.current)) return;
    const rect = trigger.current.getBoundingClientRect();
    setPlace({
      left: Math.max(
        MENU_MARGIN,
        Math.min(
          rect.left,
          window.innerWidth - list.current.offsetWidth - MENU_MARGIN
        )
      ),
      top: rect.bottom + 4,
    });
    if (viaKeyboard.current)
      list.current.querySelector<HTMLElement>('button:enabled')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !(trigger.current?.contains(target) || list.current?.contains(target))
      )
        close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      // Opened by mouse, the focus never left the document.
      if (viaKeyboard.current) trigger.current?.focus();
    };
    const onScroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [
      ...(list.current?.querySelectorAll<HTMLElement>('button:enabled') ?? []),
    ];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  };

  const glyph = api.glyphs[entry.id];
  const small = !big;
  const label = (box && tickedLabel(entry.items)) || entry.label;
  return (
    <div className="office-ribbon__dropdown" data-split={!!split || undefined}>
      {split && (
        <button
          aria-label={split.label}
          className="office-ribbon__split-top"
          data-big={big || undefined}
          data-command={split.id}
          disabled={split.disabled}
          onClick={() => runItem(api, split)}
          {...PRESS}
          title={title(split)}
          type="button"
        >
          <TablerIcon
            glyph={api.glyphs[split.id]}
            size={big ? BIG_ICON : SMALL_ICON}
          />
        </button>
      )}
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={split ? entry.label : label}
        className={
          split ? 'office-ribbon__split-bottom' : 'office-ribbon__button'
        }
        data-big={big || undefined}
        data-box={box || undefined}
        data-command={entry.id}
        data-icon-only={(iconOnly && !!glyph) || undefined}
        disabled={entry.disabled}
        onClick={(event) => {
          viaKeyboard.current = event.detail === 0;
          setOpen((value) => !value);
        }}
        {...PRESS}
        ref={trigger}
        title={split ? entry.label : label}
        type="button"
      >
        {!(split || box) && glyph && (
          <TablerIcon glyph={glyph} size={small ? SMALL_ICON : BIG_ICON} />
        )}
        {split && big ? (
          <span className="office-ribbon__big-label">
            <span>{split.label}</span>
            <Chevron size={BIG_CHEVRON} />
          </span>
        ) : big ? (
          <span className="office-ribbon__big-label">
            <span>{label}</span>
            <Chevron size={BIG_CHEVRON} />
          </span>
        ) : (
          <>
            {!(iconOnly && glyph) && !split && <span>{label}</span>}
            <Chevron />
          </>
        )}
      </button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move through the rows
        <div
          aria-label={entry.label}
          className="office-ribbon__menu"
          onKeyDown={moveFocus}
          {...PRESS}
          ref={list}
          role="menu"
          style={place}
        >
          <MenuRows api={api} close={close} entries={entry.items} />
        </div>
      )}
    </div>
  );
}

/** The dropdown's first items as tiles beside its arrow (PowerPoint's layouts). */
function RibbonGallery({ api, entry }: { api: RibbonApi; entry: MenuEntry }) {
  const tiles = entry.items
    .filter((item): item is ItemEntry => item.kind === 'item')
    .slice(0, 3);
  return (
    <div className="office-ribbon-gallery" role="group">
      {tiles.map((item) => (
        <button
          aria-label={item.label}
          className="office-ribbon__layout"
          data-command={item.id}
          disabled={item.disabled}
          key={item.id}
          onClick={() => runItem(api, item)}
          {...PRESS}
          title={item.label}
          type="button"
        >
          <i />
          <span>{item.label}</span>
        </button>
      ))}
      <RibbonMenu api={api} entry={entry} iconOnly />
    </div>
  );
}

function Cell({
  api,
  big,
  cell,
  controls,
  menus,
}: {
  api: RibbonApi;
  big?: boolean;
  cell: RibbonCell;
  controls: Record<string, ReactNode>;
  menus: Parameters<typeof findRibbonEntry>[0];
}) {
  const spec: Exclude<RibbonCell, string> =
    typeof cell === 'string' ? { id: cell } : cell;
  const control = controls[spec.id];
  if (control) return control;
  const found = findRibbonEntry(menus, spec.id);
  if (!found || found.kind === 'separator' || found.kind === 'grid')
    return null;
  const entry = spec.label ? { ...found, label: spec.label() } : found;
  if (entry.kind === 'item')
    return (
      <RibbonButton api={api} big={big} entry={entry} iconOnly={spec.icon} />
    );
  if (spec.gallery) return <RibbonGallery api={api} entry={entry} />;
  const split = spec.split ? findRibbonEntry(menus, spec.split) : undefined;
  return (
    <RibbonMenu
      api={api}
      big={big}
      box={spec.box}
      entry={entry}
      iconOnly={spec.icon}
      split={split?.kind === 'item' ? split : undefined}
    />
  );
}

/** Whether any of a group's cells draws: an out-of-context group goes away. */
function groupDraws(
  group: Group,
  controls: Record<string, ReactNode>,
  menus: Parameters<typeof findRibbonEntry>[0]
) {
  return [...(group.big ?? []), ...(group.lines ?? []).flat()].some((cell) => {
    const id = typeof cell === 'string' ? cell : cell.id;
    return !!controls[id] || !!findRibbonEntry(menus, id);
  });
}

/**
 * The strip under the ribbon: Capy's own banner (FileBanner), drawn here so it
 * sits under the ribbon as Office's message bar (Q566). Its clicks go back to
 * the host, which holds the actions.
 */
function RibbonBanner({
  banner,
  onAction,
}: {
  banner: NonNullable<ReturnType<RibbonStore['get']>['banner']>;
  onAction: (action: number | 'close') => void;
}) {
  return (
    <div
      className="office-banner"
      data-inline={banner.inline || undefined}
      data-kind={banner.kind}
      data-testid={banner.testId}
      data-tone={banner.tone}
      role={banner.tone === 'error' ? 'alert' : 'status'}
    >
      <p>{banner.message}</p>
      {banner.actions.map((action, index) => (
        <button
          disabled={action.disabled}
          key={action.label}
          onClick={() => onAction(index)}
          type="button"
        >
          {action.label}
        </button>
      ))}
      {banner.closeable && !banner.actions.length && (
        <button
          aria-label={m.action_close()}
          className="office-banner__close"
          onClick={() => onAction('close')}
          type="button"
        >
          <TablerIcon glyph={x} size={16} />
        </button>
      )}
    </div>
  );
}

/** The props every editor host passes for its ribbon. */
export interface OfficeRibbonHost {
  onBannerAction: (action: number | 'close') => void;
  store: RibbonStore;
}

/**
 * The ribbon (Q562): the tab line is in Capy's header, this is what its tab
 * shows. Groups come from `layout`, naming the editor toolbar's `controls` and
 * the entries of its menus, so every command a menu had stays one click away.
 * Below md it is one row under the tabs (Q597); collapsed, a clicked tab's
 * ribbon opens over the page until a click elsewhere or a command, as in Office.
 */
export function OfficeRibbon({
  contexts = {},
  controls,
  layout,
  onBannerAction,
  phone,
  store,
}: {
  /** Which control means each contextual tab is on. */
  contexts?: Partial<Record<RibbonContext, string>>;
  controls: Record<string, ReactNode>;
  layout: RibbonLayout;
  onBannerAction: (action: number | 'close') => void;
  phone: boolean;
  store: RibbonStore;
}) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const scroll = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { collapsed, over, menus, tab } = state;

  const inContext = (Object.keys(contexts) as RibbonContext[]).filter(
    (context) => {
      const control = contexts[context];
      return !!(control && controls[control]);
    }
  );
  const contextKey = inContext.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list by its value
  useEffect(() => {
    store.setContexts(inContext);
  }, [contextKey, store]);

  // A mouse wheel scrolls the row sideways; an edge with more to scroll fades.
  const shown = !collapsed || over;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new row, or new contents
  useEffect(() => {
    const row = scroll.current;
    if (!row) return;
    const mark = () => {
      const max = row.scrollWidth - row.clientWidth;
      row.toggleAttribute('data-scroll-start', row.scrollLeft > 1);
      row.toggleAttribute('data-scroll-end', row.scrollLeft < max - 1);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || row.scrollWidth <= row.clientWidth) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    mark();
    const observer = new ResizeObserver(mark);
    observer.observe(row);
    row.addEventListener('scroll', mark, { passive: true });
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', mark);
      row.removeEventListener('wheel', onWheel);
    };
  }, [shown, tab]);

  // What's over the page closes with a click elsewhere (a click in Capy takes
  // this window's focus; its tab line keeps it), or Escape.
  useEffect(() => {
    if (!over) return;
    const outside = (event: Event) => {
      const target = event.target as Element;
      if (
        !(
          bar.current?.contains(target) ||
          target.closest?.(
            '[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-docx-escape-layer]'
          )
        )
      )
        store.closeOver();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') store.closeOver();
    };
    const onBlur = () => store.closeOver();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [over, store]);

  const groups =
    phone && tab === HOME_TAB ? layout.phoneHome : (layout.tabs[tab] ?? []);
  const drawn = groups.filter((group) => groupDraws(group, controls, menus));
  const api: RibbonApi = { glyphs: layout.glyphs, run: store.run };

  return (
    <div className="office-ribbon" data-phone={phone || undefined}>
      {shown && (
        // biome-ignore lint/a11y/noStaticElementInteractions: a command run from what's over the page closes it
        <div
          className="office-ribbon__bar"
          data-over={over || undefined}
          data-tab={tab}
          // After the button's own handler, which closing first would unmount.
          onClick={(event) => {
            if (!over) return;
            const target = event.target as Element;
            if (
              target.closest('button, [role="option"], [role="menuitem"]') &&
              !target.closest('[aria-haspopup], [role="combobox"]')
            )
              store.closeOver();
          }}
          ref={bar}
        >
          <div className="office-ribbon__scroll" ref={scroll}>
            {drawn.map((group, index) => (
              <div
                aria-label={group.label()}
                className="office-ribbon__group"
                key={`${tab}-${index}`}
                role="group"
              >
                <div className="office-ribbon__body">
                  {group.big?.map((cell, cellIndex) => (
                    <Cell
                      api={api}
                      big
                      cell={cell}
                      controls={controls}
                      key={cellIndex}
                      menus={menus}
                    />
                  ))}
                  {group.lines && (
                    <div className="office-ribbon__lines">
                      {group.lines.map((line, lineIndex) => (
                        <div className="office-ribbon__line" key={lineIndex}>
                          {line.map((cell, cellIndex) => (
                            <Cell
                              api={api}
                              cell={cell}
                              controls={controls}
                              key={cellIndex}
                              menus={menus}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="office-ribbon__caption">{group.label()}</div>
              </div>
            ))}
          </div>
          {!phone && (
            <button
              aria-label={
                over
                  ? m.files_office_ribbon_keep()
                  : m.files_office_ribbon_collapse()
              }
              className="office-ribbon__collapse"
              data-testid="office-ribbon-collapse"
              onClick={() => store.command(OFFICE_RIBBON_COMMANDS.collapse)}
              {...PRESS}
              title={
                over
                  ? m.files_office_ribbon_keep()
                  : m.files_office_ribbon_collapse()
              }
              type="button"
            >
              <TablerIcon glyph={over ? pin : chevronUp} size={16} />
            </button>
          )}
        </div>
      )}
      {state.banner && (
        <RibbonBanner banner={state.banner} onAction={onBannerAction} />
      )}
    </div>
  );
}
