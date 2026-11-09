import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
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
  findRibbonCell,
  HOME_TAB,
  type RibbonContext,
  type RibbonStore,
  returnKeys,
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
/** The frame width below which the ribbon is one row (Q597, Q677). */
const ONE_ROW = '(max-width: 767.98px)';
/** `.office-ribbon__more`'s width, kept free once a group moves into it. */
const MORE_WIDTH = 56;
/** Everything in the bar that is an open list, whoever draws it. */
const LIST =
  '[role="menu"], [role="listbox"], [role="dialog"], [data-docx-escape-layer]';
const ROW = 'button:enabled, [role="option"]';
const F_KEY = /^F\d+$/;

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

/** Whether a click ran something, rather than opening a list or a box. */
function isCommand(target: Element) {
  return (
    !!target.closest('button, [role="option"], [role="menuitem"]') &&
    !target.closest('[aria-haspopup], [role="combobox"]')
  );
}

/** The row an arrow, Home or End moves to; a grid's rows are its cells. */
function nextRow(rows: HTMLElement[], at: number, key: string, list: Element) {
  if (key === 'Home') return rows[0];
  if (key === 'End') return rows.at(-1);
  const across = list.querySelector('[role="grid"]') ? GRID_SIZE : 1;
  const step = {
    ArrowDown: across,
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -across,
  }[key];
  if (!step) return;
  if (at < 0) return step > 0 ? rows[0] : rows.at(-1);
  return rows[(at + step + rows.length) % rows.length];
}

/** The open list's rows and which one is marked, without taking the focus. */
function holdKeys(root: HTMLElement) {
  let active: HTMLElement | null = null;
  const mark = (row: HTMLElement | null, hover = true) => {
    if (row === active) return;
    active?.removeAttribute('data-active');
    row?.setAttribute('data-active', 'true');
    // The rows' own hover state follows: Capy's grid shows its size, the
    // toolbar's lists their highlight. A `mouseout` is what React reads both from.
    if (hover && row)
      (active ?? row).dispatchEvent(
        new window.MouseEvent(active ? 'mouseout' : 'mouseover', {
          bubbles: true,
          relatedTarget: active ? row : null,
        })
      );
    active = row;
    row?.scrollIntoView({ block: 'nearest' });
  };
  // An IME can't start in the document under the list. Restored on close; a
  // pause that lands while a list is open is put right by its next render.
  const held = document.activeElement;
  const field =
    !root.contains(held) &&
    (held instanceof HTMLTextAreaElement || held instanceof HTMLInputElement) &&
    !held.readOnly
      ? held
      : null;
  if (field) field.readOnly = true;
  const onKey = (event: globalThis.KeyboardEvent) => {
    // With the focus in the ribbon its own controls take their keys.
    if (root.contains(event.target as Node)) return;
    const trigger = [
      ...root.querySelectorAll<HTMLElement>('[aria-expanded="true"]'),
    ].at(-1);
    if (!trigger) return;
    event.stopImmediatePropagation();
    // A browser's own F keys stay (reload); nothing reaches the document.
    if (!F_KEY.test(event.key)) event.preventDefault();
    if (event.key === 'Escape' || event.key === 'Tab') {
      trigger.click();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (active?.isConnected) active.click();
      else trigger.click();
      return;
    }
    const list = [...root.querySelectorAll(LIST)].at(-1);
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>(ROW)];
    const row = nextRow(
      rows,
      active ? rows.indexOf(active) : -1,
      event.key,
      list
    );
    if (row) mark(row);
  };
  const onHover = (event: Event) => {
    const row = (event.target as Element).closest<HTMLElement>(ROW);
    if (row?.closest(LIST)) mark(row, false);
  };
  window.addEventListener('keydown', onKey, true);
  root.addEventListener('mouseover', onHover);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    root.removeEventListener('mouseover', onHover);
    active?.removeAttribute('data-active');
    if (field) field.readOnly = false;
  };
}

/**
 * An open list owns the keyboard. Opened by mouse, the focus stays in the
 * document, because leaving would commit an XLSX cell being typed (its blur
 * commits; Excel keeps the entry open under a list too), so the keys are taken
 * before the editor sees them and the arrows walk a marked row. Opened by
 * keyboard, the list has the real focus. An attribute observer keeps all this
 * off the typing path: nothing listens while no list is open.
 */
function useListKeys(bar: RefObject<HTMLDivElement | null>, shown: boolean) {
  useEffect(() => {
    const root = bar.current;
    if (!root) return;
    let stop: (() => void) | null = null;
    const sync = () => {
      if (root.querySelector('[aria-expanded="true"]')) {
        if (stop) return;
        stop = holdKeys(root);
        gone.observe(root, { childList: true, subtree: true });
      } else if (stop) {
        stop();
        stop = null;
        gone.disconnect();
      }
    };
    const observer = new MutationObserver(sync);
    // A list can also go with its tab, while one is open only.
    const gone = new MutationObserver(sync);
    observer.observe(root, {
      attributeFilter: ['aria-expanded'],
      attributes: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      gone.disconnect();
      stop?.();
    };
  }, [bar, shown]);
}

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(value, high));

/** Under its trigger, inside the frame on every side; it scrolls inside. */
function fitInFrame(trigger: HTMLElement, list: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const maxHeight = window.innerHeight - 2 * MENU_MARGIN;
  return {
    left: clamp(
      rect.left,
      MENU_MARGIN,
      window.innerWidth - list.offsetWidth - MENU_MARGIN
    ),
    maxHeight,
    maxWidth: window.innerWidth - 2 * MENU_MARGIN,
    top: clamp(
      rect.bottom + 4,
      MENU_MARGIN,
      window.innerHeight - Math.min(list.scrollHeight, maxHeight) - MENU_MARGIN
    ),
  };
}

/** A trigger and its list: placement, closing, and the keys with focus in it. */
function usePopup() {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const viaKeyboard = useRef(false);
  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open) return;
    const replace = () => {
      if (trigger.current && list.current)
        setPlace(fitInFrame(trigger.current, list.current));
    };
    replace();
    if (viaKeyboard.current)
      list.current?.querySelector<HTMLElement>(ROW)?.focus();
    window.addEventListener('resize', replace);
    return () => window.removeEventListener('resize', replace);
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
      if (event.key === 'Escape') close();
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

  return {
    close,
    list,
    /** With the focus in the list: arrows move it, Escape goes to the trigger. */
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        trigger.current?.focus();
        return;
      }
      if ((event.target as Element).matches('input')) return;
      const rows = [
        ...(list.current?.querySelectorAll<HTMLElement>(ROW) ?? []),
      ];
      const row =
        list.current &&
        nextRow(
          rows,
          rows.indexOf(document.activeElement as HTMLElement),
          event.key,
          list.current
        );
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      row.focus();
    },
    open,
    place,
    toggle: (event: MouseEvent) => {
      viaKeyboard.current = event.detail === 0;
      setOpen((value) => !value);
    },
    trigger,
  };
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
        {size.rows ? `${size.rows} × ${size.cols}` : ' '}
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
  ticks,
}: {
  api: RibbonApi;
  big?: boolean;
  box?: boolean;
  entry: MenuEntry;
  iconOnly?: boolean;
  /** The item a split's upper half runs. */
  split?: ItemEntry;
  /** Shows as on while one of its items is ticked (an armed tool). */
  ticks?: boolean;
}) {
  const popup = usePopup();
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
        aria-expanded={popup.open}
        aria-haspopup="menu"
        aria-label={split ? entry.label : label}
        className={
          split ? 'office-ribbon__split-bottom' : 'office-ribbon__button'
        }
        data-big={big || undefined}
        data-box={box || undefined}
        data-checked={(ticks && !!tickedLabel(entry.items)) || undefined}
        data-command={entry.id}
        data-icon-only={(iconOnly && !!glyph) || undefined}
        disabled={entry.disabled}
        onClick={popup.toggle}
        {...PRESS}
        ref={popup.trigger}
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
      {popup.open && (
        <div
          aria-label={entry.label}
          className="office-ribbon__menu"
          onKeyDown={popup.onKeyDown}
          {...PRESS}
          ref={popup.list}
          role="menu"
          style={popup.place}
        >
          <MenuRows api={api} close={popup.close} entries={entry.items} />
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

/** What a group's cells read: the toolbar's controls and the editor's menus. */
interface GroupSources {
  api: RibbonApi;
  controls: Partial<Record<string, ReactNode>>;
  menus: Parameters<typeof findRibbonCell>[0];
}

function Cell({
  api,
  big,
  cell,
  controls,
  menus,
}: GroupSources & { big?: boolean; cell: RibbonCell }) {
  const spec: Exclude<RibbonCell, string> =
    typeof cell === 'string' ? { id: cell } : cell;
  const control = controls[spec.id];
  if (control) return control;
  const found = findRibbonCell(menus, spec);
  if (!found) return null;
  const entry = spec.label ? { ...found, label: spec.label() } : found;
  if (entry.kind === 'item')
    return (
      <RibbonButton api={api} big={big} entry={entry} iconOnly={spec.icon} />
    );
  if (spec.gallery) return <RibbonGallery api={api} entry={entry} />;
  const split = spec.split ? findRibbonCell(menus, { id: spec.split }) : null;
  return (
    <RibbonMenu
      api={api}
      big={big}
      box={spec.box}
      entry={entry}
      iconOnly={spec.icon}
      split={split?.kind === 'item' ? split : undefined}
      ticks={spec.ticks}
    />
  );
}

/** Whether any of a group's cells draws: an out-of-context group goes away. */
function groupDraws(
  group: Group,
  controls: GroupSources['controls'],
  menus: GroupSources['menus']
) {
  return [...(group.big ?? []), ...(group.lines ?? []).flat()].some((cell) => {
    const spec = typeof cell === 'string' ? { id: cell } : cell;
    return !!controls[spec.id] || !!findRibbonCell(menus, spec);
  });
}

function RibbonGroupView({
  group,
  ...sources
}: GroupSources & { group: Group }) {
  return (
    <div
      aria-label={group.label()}
      className="office-ribbon__group"
      role="group"
    >
      <div className="office-ribbon__body">
        {group.big?.map((cell, index) => (
          <Cell {...sources} big cell={cell} key={index} />
        ))}
        {group.lines && (
          <div className="office-ribbon__lines">
            {group.lines.map((line, lineIndex) => (
              <div className="office-ribbon__line" key={lineIndex}>
                {line.map((cell, index) => (
                  <Cell {...sources} cell={cell} key={index} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="office-ribbon__caption">{group.label()}</div>
    </div>
  );
}

/** The groups that don't fit the row, one button at its end (Q675 B). */
function MoreGroups({
  groups,
  ...sources
}: GroupSources & { groups: readonly Group[] }) {
  const popup = usePopup();
  return (
    <div className="office-ribbon__dropdown office-ribbon__more">
      <button
        aria-expanded={popup.open}
        aria-haspopup="dialog"
        aria-label={m.files_office_ribbon_more()}
        className="office-ribbon__button"
        data-big
        data-testid="office-ribbon-more"
        onClick={popup.toggle}
        {...PRESS}
        ref={popup.trigger}
        title={m.files_office_ribbon_more()}
        type="button"
      >
        <span className="office-ribbon__big-label">
          <span>{m.files_office_ribbon_more()}</span>
          <Chevron size={BIG_CHEVRON} />
        </span>
      </button>
      {popup.open && (
        <div
          aria-label={m.files_office_ribbon_more()}
          className="office-ribbon__menu office-ribbon__more-list"
          data-testid="office-ribbon-more-list"
          onClick={(event) => {
            if (isCommand(event.target as Element)) popup.close();
          }}
          onKeyDown={popup.onKeyDown}
          onMouseDown={(event) => {
            // A box in a moved group takes the focus; the rest keeps it.
            if (!(event.target as Element).matches('input, select, textarea'))
              event.preventDefault();
          }}
          onMouseUp={PRESS.onMouseUp}
          ref={popup.list}
          role="dialog"
          style={popup.place}
        >
          {groups.map((group, index) => (
            <RibbonGroupView {...sources} group={group} key={index} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * How many of the row's groups fit (Q675 B); the rest move to More from the
 * tab's end. Every group is measured once in the row before paint when the tab
 * or its groups change; after that a ResizeObserver reports the row's width and
 * the groups' sizes, so typing and selection read no layout. A group in More
 * keeps its last width until it comes back.
 */
function useRowFit(
  row: RefObject<HTMLDivElement | null>,
  key: string,
  off: boolean
) {
  const [fit, setFit] = useState({ count: 0, key: '' });
  const widths = useRef<number[]>([]);
  const measured = useRef('');
  const count = !off && fit.key === key ? fit.count : Number.POSITIVE_INFINITY;

  useLayoutEffect(() => {
    const element = row.current;
    if (off || !element) return;
    if (measured.current !== key) {
      measured.current = key;
      widths.current = [];
    }
    const groups = [
      ...element.querySelectorAll<HTMLElement>(
        ':scope > .office-ribbon__group'
      ),
    ];
    const place = () => {
      groups.forEach((group, index) => {
        widths.current[index] = Math.ceil(group.getBoundingClientRect().width);
      });
      const room = element.clientWidth;
      const all = widths.current.reduce((sum, width) => sum + width, 0);
      let next = widths.current.length;
      if (all > room) {
        let used = MORE_WIDTH;
        next = widths.current.findIndex((width) => {
          used += width;
          return used > room;
        });
      }
      setFit((last) =>
        last.key === key && last.count === next ? last : { count: next, key }
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    for (const group of groups) observer.observe(group);
    return () => observer.disconnect();
  }, [count, key, off, row]);
  return count;
}

/**
 * The strip under the ribbon: Capy's own banner (FileBanner), drawn here so it
 * sits under the ribbon as Office's message bar (Q566). Its clicks go back to
 * the host, which holds the actions. As in FileBanner, only an inline strip's
 * actions take the close button's place.
 */
export function RibbonBanner({
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
      {banner.closeable && !(banner.inline && banner.actions.length) && (
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
  /** The keyboard goes back to Capy's tab line. */
  onLeave: () => void;
  store: RibbonStore;
}

/**
 * The ribbon (Q562): the tab line is in Capy's header, this is what its tab
 * shows. Groups come from `layout`, naming the editor toolbar's `controls` and
 * the entries of its menus, so every command a menu had stays one click away.
 * A frame under 768 px has one row under the tabs (Q597, Q677: the frame's own
 * width, whatever the window); from there up what doesn't fit goes to More
 * (Q675). Collapsed, a clicked tab's ribbon opens over the page until a click
 * elsewhere or a command, as in Office.
 */
export function OfficeRibbon({
  contexts = {},
  controls,
  layout,
  onBannerAction,
  onLeave,
  store,
}: OfficeRibbonHost & {
  /** Which control means each contextual tab is on. */
  contexts?: Partial<Record<RibbonContext, string>>;
  controls: GroupSources['controls'];
  layout: RibbonLayout;
}) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const scroll = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { collapsed, focusRequest, over, menus, tab } = state;

  // A crossing renders; a resize on either side of it does nothing, and no
  // message is sent (the tab line is the same at every width).
  const [oneRow] = useState(() => window.matchMedia(ONE_ROW));
  const phone = useSyncExternalStore(
    (changed) => {
      oneRow.addEventListener('change', changed);
      return () => oneRow.removeEventListener('change', changed);
    },
    () => oneRow.matches
  );

  // The host's strips and its tab line follow this: nothing goes to a ribbon
  // that an error boundary took away.
  useEffect(() => {
    store.setMounted(true);
    return () => store.setMounted(false);
  }, [store]);

  // A developer journey's render error, under the editor's error boundary.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!(import.meta.env.DEV && import.meta.env.VITE_USE_MSW !== 'false'))
      return;
    const fail = () => setFailed(true);
    window.addEventListener('capy-scenario-ribbon-failure', fail);
    return () =>
      window.removeEventListener('capy-scenario-ribbon-failure', fail);
  }, []);
  if (failed) throw new Error('The ribbon could not be drawn.');

  const inContext = (Object.keys(contexts) as RibbonContext[]).filter(
    (context) => {
      const control = contexts[context];
      return !!(control && controls[control]);
    }
  );
  const contextKey = inContext.join();
  useEffect(() => {
    store.setContexts(inContext);
  }, [contextKey, store]);

  // A mouse wheel scrolls the phone's row sideways; an edge with more to scroll
  // fades. From 768 px up the row doesn't scroll: what doesn't fit is in More.
  const shown = !collapsed || over;
  useEffect(() => {
    const row = scroll.current;
    if (!(row && phone)) return;
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
      row.removeAttribute('data-scroll-start');
      row.removeAttribute('data-scroll-end');
    };
  }, [phone, shown, tab]);

  useListKeys(bar, shown);

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

  // Enter or an arrow on Capy's tab line: its tab's first command has the keys.
  const fromTabLine = useRef(false);
  const lastFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = focusRequest;
    fromTabLine.current = true;
    scroll.current
      ?.querySelector<HTMLElement>('button:enabled, input:enabled')
      ?.focus();
  }, [focusRequest]);

  const onBarKeys = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(LIST)) return;
    const inBox = target.matches('input, select, textarea');
    if (event.key === 'Escape') {
      // Back where the keys came from.
      if (fromTabLine.current) {
        fromTabLine.current = false;
        onLeave();
      } else if (inBox) returnKeys(store.focusDocument);
      return;
    }
    if (event.key === 'Enter' && inBox) {
      returnKeys(store.focusDocument);
      return;
    }
    const controlsInRow = [
      ...(scroll.current?.querySelectorAll<HTMLElement>(
        'button:enabled, input:enabled'
      ) ?? []),
    ];
    const at = controlsInRow.indexOf(target);
    if (event.key === 'Tab' && event.shiftKey && at === 0) {
      event.preventDefault();
      fromTabLine.current = false;
      onLeave();
      return;
    }
    if (inBox || at < 0) return;
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    controlsInRow[
      (at + step + controlsInRow.length) % controlsInRow.length
    ]?.focus();
  };

  const groups =
    phone && tab === HOME_TAB ? layout.phoneHome : (layout.tabs[tab] ?? []);
  const drawn = groups.filter((group) => groupDraws(group, controls, menus));
  const fits = useRowFit(
    scroll,
    `${tab}:${drawn.length}:${shown}`,
    phone || !shown
  );
  const sources: GroupSources = {
    api: { glyphs: layout.glyphs, run: store.run },
    controls,
    menus,
  };

  return (
    <div className="office-ribbon" data-phone={phone || undefined}>
      {shown && (
        <div
          className="office-ribbon__bar"
          data-over={over || undefined}
          data-tab={tab}
          // After the button's own handler, which closing first would unmount.
          onClick={(event) => {
            if (!isCommand(event.target as Element)) return;
            if (over) store.closeOver();
            // A command is done or a row is gone: the document has the keys.
            returnKeys(store.focusDocument);
          }}
          onKeyDown={onBarKeys}
          onPointerDown={() => {
            fromTabLine.current = false;
          }}
          ref={bar}
        >
          <div className="office-ribbon__scroll" ref={scroll}>
            {drawn.slice(0, fits).map((group, index) => (
              <RibbonGroupView
                {...sources}
                group={group}
                key={`${tab}-${index}`}
              />
            ))}
            {fits < drawn.length && (
              <MoreGroups {...sources} groups={drawn.slice(fits)} />
            )}
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
