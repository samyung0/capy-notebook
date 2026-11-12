import type { IconName } from '@/components/ui/Icon';
import { getLocale, m } from '@/i18n';
import type { ColumnKind, OptionColor, ViewKind } from './model';

/* How the table view editor draws its parts (mock 9nQns9KAvwafQT2LyK7fHt). */

/** An option chip's fill and text in each colour, light and dark. */
export const OPTION_CHIP_CLASS: Record<OptionColor, string> = {
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
  brown: 'bg-[#f1e9e3] text-[#7a4f32] dark:bg-[#4a3428]/70 dark:text-[#e3c8b5]',
  gray: 'bg-stone-100 text-stone-700 dark:bg-stone-700/60 dark:text-stone-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
  orange:
    'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900/50 dark:text-pink-200',
  purple:
    'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
  yellow:
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
};

export const OPTION_COLOR_LABEL: Record<OptionColor, () => string> = {
  blue: m.table_view_color_blue,
  brown: m.table_view_color_brown,
  gray: m.table_view_color_gray,
  green: m.table_view_color_green,
  orange: m.table_view_color_orange,
  pink: m.table_view_color_pink,
  purple: m.table_view_color_purple,
  red: m.table_view_color_red,
  yellow: m.table_view_color_yellow,
};

export const COLUMN_ICON: Record<ColumnKind, IconName> = {
  checkbox: 'checkbox',
  date: 'schedule',
  number: 'hash',
  select: 'circleCheck',
  text: 'text',
  title: 'text',
};

export const COLUMN_KIND_LABEL: Record<ColumnKind, () => string> = {
  checkbox: m.table_view_kind_checkbox,
  date: m.table_view_kind_date,
  number: m.table_view_kind_number,
  select: m.table_view_kind_select,
  text: m.table_view_kind_text,
  title: m.table_view_kind_text,
};

export const VIEW_ICON: Record<ViewKind, IconName> = {
  kanban: 'kanban',
  table: 'tableView',
};

export const VIEW_KIND_LABEL: Record<ViewKind, () => string> = {
  kanban: m.table_view_kanban,
  table: m.editor_table,
};

/** A column's width in px as drawn, on phones and from `sm` (mock Phone:
 * the title column 140px, the rest narrower than on wide screens). */
export const COLUMN_WIDTH: Record<ColumnKind, readonly [number, number]> = {
  checkbox: [72, 80],
  date: [96, 120],
  number: [72, 96],
  select: [112, 140],
  text: [128, 180],
  title: [140, 220],
};

/** The widths as the `--w-phone` and `--w-wide` a `w-(--w-phone)
 * sm:w-(--w-wide)` element reads. */
export const widthVars = ([phone, wide]: readonly [number, number]) =>
  ({
    '--w-phone': `${phone}px`,
    '--w-wide': `${wide}px`,
  }) as React.CSSProperties;

/** A `YYYY-MM-DD` cell as the reader's locale writes "12 Nov", with the year
 * when it is not this one. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'short',
    ...(year === new Date().getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

/** A local date as a `YYYY-MM-DD` cell. */
export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** A `YYYY-MM-DD` cell as a local date. */
export function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}
