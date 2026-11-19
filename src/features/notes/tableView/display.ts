import type { IconName } from '@/components/ui/Icon';
import { getLocale } from '@/i18n';
import type { ColumnKind, OptionColor, TableViewColumn } from './model';

/* How a table view looks wherever the app draws it (the read-only table, the
   editor's cells and Kanban cards): one icon per column kind, one chip colour
   per option colour, dates as "12 Nov". No browser API, so a share page's
   Worker renders it too. */

/** The header icon of each column kind (mock 9nQns9KAvwafQT2LyK7fHt). */
export const COLUMN_ICON: Record<ColumnKind, IconName> = {
  checkbox: 'checkSquare',
  date: 'schedule',
  number: 'hashtag',
  select: 'circleCheck',
  text: 'alignLeft',
  title: 'text',
};

/** A select option's chip: its tint and a darker text of the same hue, in
 * light and dark (the mock's grey, orange and green, the rest alike). */
export const OPTION_CHIP_CLASS: Record<OptionColor, string> = {
  blue: 'bg-[#e5f0fb] text-[#24609e] dark:bg-[#1f3247] dark:text-[#93c2f2]',
  brown: 'bg-[#f2e9e3] text-[#7a5038] dark:bg-[#43342b] dark:text-[#e0bfa8]',
  gray: 'bg-[#efefed] text-[#4f4f4d] dark:bg-[#3a3a38] dark:text-[#d4d4d2]',
  green: 'bg-[#e6f4ea] text-[#24723b] dark:bg-[#1f3a2a] dark:text-[#8fd6a6]',
  orange: 'bg-[#fbefe2] text-[#9a5412] dark:bg-[#4a3220] dark:text-[#f5c38f]',
  pink: 'bg-[#fae9f2] text-[#a23a72] dark:bg-[#47263a] dark:text-[#f0a9cf]',
  purple: 'bg-[#efeafa] text-[#6a45a8] dark:bg-[#352a4a] dark:text-[#c6b2f2]',
  red: 'bg-[#fce8e6] text-[#b33a32] dark:bg-[#4a2523] dark:text-[#f3a49d]',
  yellow: 'bg-[#fbf3db] text-[#80620c] dark:bg-[#463c1d] dark:text-[#ecd27e]',
};

/** The chip's shape, beside its colour. */
export const OPTION_CHIP_SHAPE =
  'inline-flex h-[22px] max-w-full items-center truncate whitespace-nowrap rounded px-2 text-[13px] leading-none';

/** A date cell (`YYYY-MM-DD`) as "12 Nov" in the reader's locale; en reads
 * day before month, as the To do boards draw it. The day is the stored one,
 * whatever the reader's time zone. */
export function tableViewDate(iso: string): string {
  const locale = getLocale() === 'en' ? 'en-GB' : getLocale();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** A column's width in px, on phones and from `sm` (mock Phone: the title
 * column 140px, the rest narrower than on wide screens). Every table drawn
 * keeps them, so a note's View and its editor draw the same shape. */
export const COLUMN_WIDTH: Record<ColumnKind, readonly [number, number]> = {
  checkbox: [72, 80],
  date: [96, 120],
  number: [72, 96],
  select: [112, 140],
  text: [128, 180],
  title: [140, 220],
};

/** The end column after the rest (the editor's + sits in it): at least this
 * wide, and it takes whatever room the columns leave, as AFFiNE's does. */
export const END_COLUMN_WIDTH = 36;

/** Widths as the `--w-phone` and `--w-wide` that `WIDTH_CLASS` reads. */
export const widthVars = ([phone, wide]: readonly [number, number]) =>
  ({
    '--w-phone': `${phone}px`,
    '--w-wide': `${wide}px`,
  }) as React.CSSProperties;

export const WIDTH_CLASS = 'w-(--w-phone) sm:w-(--w-wide)';

/** The table's least width: its columns' and the end column's. */
export const tableWidth = (columns: TableViewColumn[]) =>
  ([0, 1] as const).map((at) =>
    columns.reduce(
      (sum, { kind }) => sum + COLUMN_WIDTH[kind][at],
      END_COLUMN_WIDTH
    )
  ) as unknown as readonly [number, number];

/** As wide as the note, its columns at their fixed widths and the end column
 * (a `<col>` with no width) taking the rest, so each row's line runs the
 * block's width (AFFiNE's look, Epo 2026-11-12); past the note's width the
 * columns after the title scroll sideways. */
export const TABLE_CLASS =
  'w-[max(100%,var(--w-phone))] table-fixed border-separate border-spacing-0 text-sm sm:w-[max(100%,var(--w-wide))]';

/** A header or body cell; its content draws the padding. */
export const CELL_CLASS = 'h-9 border-line border-b p-0 align-middle';
/** Each cell but a row's first has a line on its left. */
export const DIVIDED_CLASS = 'border-l';
/** The title column stays while the rest scroll under it (mock Phone). */
export const STICKY_CLASS =
  'sticky left-0 z-[1] bg-surface shadow-[4px_0_6px_-4px_rgb(0_0_0/0.12)] sm:shadow-none';
/** A header cell's own look. */
export const HEADER_CLASS = 'text-left font-medium text-fg-muted';
/** A cell's content: one line, cut with an ellipsis. */
export const CELL_CONTENT_CLASS =
  'flex h-9 w-full min-w-0 items-center px-2.5 text-left';
