import type { LinkProps } from '@tanstack/react-router';
import { memo } from 'react';
import type { MaterialListItem } from '@/api/types';
import { ItemCard } from '@/components/app/ItemCard';
import type { ListView } from '@/components/app/ListToolbar';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { formatFileSize } from '@/features/files/fileUtils';
import { getLocale, m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';
import { cardCountLabel, questionCountLabel } from './countLabels';

/** Blocks tab item mapped onto the shared ItemCard. The tab owns navigation,
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
    case 'mindmap':
      return m.generate_kind_mindmap();
    case 'diagram':
      return m.generate_kind_diagram();
    case 'note':
      return m.create_kind_note();
  }
}

/** The list's Details column: the count where the kind has one, then the
 * size, so a note's row is not empty. */
function materialListDetails(item: MaterialListItem): string {
  const size = formatFileSize(item.sizeBytes);
  const count = materialDetails(item);
  return count ? `${count} · ${size}` : size;
}

/** The per-kind detail line: question or card count, or nothing. */
export function materialDetails(item: MaterialListItem): string {
  if (item.kind === 'quiz') return questionCountLabel(item.questionCount ?? 0);
  if (item.kind === 'flashcards') return cardCountLabel(item.cardCount ?? 0);
  return '';
}

/** One block in the Blocks tab, pickable there. Memoised: its menu and link
 * come from the tab's stable `menuFor` and `linkFor`, so a pick re-renders
 * only the cards whose selection changed. */
export const MaterialCard = memo(function MaterialCard({
  item,
  view,
  menuFor,
  linkFor,
  selected,
  workspaceIconId,
}: {
  item: MaterialListItem;
  view: ListView;
  menuFor: (item: MaterialListItem) => MenuItem[];
  linkFor: (item: MaterialListItem) => LinkProps;
  selected: boolean;
  workspaceIconId?: string;
}) {
  return (
    <ItemCard
      actions={<Menu items={menuFor(item)} triggerIcon="moreHorizontal" />}
      details={materialListDetails(item)}
      icon={materialIconName(item.kind)}
      link={item.lostAccess ? undefined : linkFor(item)}
      meta={relativeTime(item.updatedAt)}
      pickKey={item.id}
      selected={selected}
      thumbnail={{
        pill: materialDetails(item) || undefined,
        preview: item.preview,
      }}
      title={item.title}
      view={view}
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
      workspaceLost={item.lostAccess}
    />
  );
});
