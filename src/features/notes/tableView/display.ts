import type { IconName } from '@/components/ui/Icon';
import { getLocale } from '@/i18n';
import type { ColumnKind, OptionColor } from './model';

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
