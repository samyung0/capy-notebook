import type { LinkProps } from '@tanstack/react-router';
import type { MaterialListItem } from '@/api/types';
import { ItemCard } from '@/components/app/ItemCard';
import type { ListView } from '@/components/app/ListToolbar';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { getLocale, m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';

/** Create page item mapped onto the shared ItemCard. The page owns navigation,
 * the action menu and every dialog. */

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_STEPS) {
    if (Math.abs(diff) >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return format.format(-1, 'minute');
}

export function materialKindLabel(kind: MaterialListItem['kind']): string {
  switch (kind) {
    case 'quiz':
      return m.editor_quiz();
    case 'flashcards':
      return m.editor_flashcards();
    default:
      return m.create_kind_note();
  }
}

/** The per-kind detail line: question or card count, or nothing. */
export function materialDetails(item: MaterialListItem): string {
  if (item.kind === 'quiz') {
    return m.material_ref_questions({ count: item.questionCount ?? 0 });
  }
  if (item.kind === 'flashcards') {
    return m.material_ref_cards({ count: item.cardCount ?? 0 });
  }
  return '';
}

export function MaterialCard({
  item,
  view,
  menu,
  link,
}: {
  item: MaterialListItem;
  view: ListView;
  menu: MenuItem[];
  link: LinkProps;
}) {
  return (
    <ItemCard
      actions={<Menu items={menu} />}
      details={materialDetails(item)}
      icon={materialIconName(item.kind)}
      link={link}
      meta={relativeTime(item.updatedAt)}
      title={item.title}
      view={view}
      workspace={item.workspaceName}
    />
  );
}
