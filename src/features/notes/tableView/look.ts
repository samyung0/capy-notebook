import type { IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import type { ColumnKind, OptionColor, ViewKind } from './model';

/* How the table view editor draws its parts (mock 9nQns9KAvwafQT2LyK7fHt);
   what every renderer shares is in display.ts. */

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

/** A local date as a `YYYY-MM-DD` cell. */
export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** A `YYYY-MM-DD` cell as a local date. */
export function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}
