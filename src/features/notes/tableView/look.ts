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

/** A local date as a `YYYY-MM-DD` cell. */
export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** A `YYYY-MM-DD` cell as a local date. */
export function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}
