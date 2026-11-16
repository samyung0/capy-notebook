import { useNavigate } from '@tanstack/react-router';
import type { ComponentProps, ReactNode, Ref } from 'react';
import {
  ariaSort,
  type ColumnSort,
  SortHeader,
  sortDirection,
} from '@/components/app/SortHeader';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The Study pages' padding: the page gutter (`page-px`), 28px above from lg. */
export function PracticeFrame({
  children,
  className,
  ref,
}: {
  children: ReactNode;
  className?: string;
  /** The page's scroller, for a paged list's ListEnd. */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    // One column leaves room under the page for the floating chat button.
    <div
      className={cn(
        'page-px min-h-0 flex-1 overflow-auto pt-5 pb-24 lg:pt-7 lg:pb-10',
        className
      )}
      ref={ref}
    >
      {children}
    </div>
  );
}

/** A header cell; with `sort` its label sorts the table (History's header). */
export function Th<S extends string>({
  children,
  className,
  sort,
}: {
  children?: ReactNode;
  className?: string;
  sort?: { sorting: ColumnSort<S>; value: S };
}) {
  return (
    <th
      aria-sort={
        sort ? ariaSort(sortDirection(sort.sorting, sort.value)) : undefined
      }
      className={cn(
        // The first and last columns start and end at the page's gutter, no
        // inset of their own (Epo 2026-11-13).
        't-meta whitespace-nowrap border-divider border-b px-3 py-1.5 text-left align-bottom font-semibold text-fg-muted first:pl-0 last:pr-0',
        className
      )}
    >
      {sort && typeof children === 'string' ? (
        <SortHeader
          label={children}
          sorting={sort.sorting}
          value={sort.value}
        />
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  className,
  muted,
}: {
  children?: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        // 36px rows (Epo 2026-11-13).
        'h-9 truncate border-divider border-b px-3 first:pl-0 last:pr-0',
        muted && 'font-semibold text-fg-muted',
        className
      )}
    >
      {children}
    </td>
  );
}

/** A narrow list's row, where the Study pages' tables do not fit (phones and
 * narrow panes): 56px at least, 8px above and below its lines, a divider
 * under it (Epo 2026-11-16). With `onOpen` the row is one button; without,
 * the page makes it clickable around controls of its own. */
export function ListRow({
  children,
  className,
  onOpen,
  ...props
}: ComponentProps<'li'> & { onOpen?: () => void }) {
  if (onOpen)
    return (
      <li className="border-divider border-b" {...props}>
        <button
          className={cn(
            'flex min-h-14 w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
            className
          )}
          onClick={onOpen}
          type="button"
        >
          {children}
        </button>
      </li>
    );
  return (
    <li
      className={cn(
        'flex min-h-14 items-center gap-3 border-divider border-b py-2',
        className
      )}
      {...props}
    >
      {children}
    </li>
  );
}

/** A narrow row's score at its end with the word that says what it is
 * ("88% overall", "74% average", "8 / 10 best"; Epo 2026-11-16): the wide
 * tables' column headers say it there. */
export function RowScore({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      <span className="font-bold">{value}</span>
      <span className="t-meta text-fg-muted">{label}</span>
    </span>
  );
}

/** "Membranes and transport +4": the main topic, then how many more (an
 * assignment's, or what a quiz covers, Epo 2026-11-15). */
export function TopicsCell({
  topicIds,
  topicName,
}: {
  topicIds: string[];
  topicName: (id: string) => string | undefined;
}) {
  const [first, ...rest] = topicIds;
  return (
    <span className="flex min-w-0 max-w-55 items-center gap-1.5">
      <span className="truncate">{first ? topicName(first) : '–'}</span>
      {rest.length > 0 && (
        <span className="shrink-0 font-bold">+{rest.length}</span>
      )}
    </span>
  );
}

export type StudyTab = 'summary' | 'topics' | 'practice' | 'bank' | 'history';

/** Study's tabs (Epo 2026-11-13): Overview (`summary`) and History for whoever
 * practises; a class's staff get Overview and Topics, every member's marks
 * (`summary`, `show=topics`), Practice and the class's Question bank (Epo
 * 2026-11-14, mock A). Inside the page's padding, laid
 * out as the account Study's tab row: the first label under the title, the
 * underline edge to edge. */
export function StudyTabs({
  staff,
  value,
}: {
  staff: boolean;
  value: StudyTab;
}) {
  const navigate = useNavigate();
  return (
    <Tabs
      className="page-bleed page-tabs-px mt-3 w-auto"
      onChange={(next) =>
        navigate({
          search:
            next === 'topics'
              ? { show: 'topics' as const, study: 'summary' as const }
              : { study: next as Exclude<StudyTab, 'topics'> },
          to: '.',
        })
      }
      tabs={[
        { label: m.learning_tab_overview(), value: 'summary' },
        ...(staff
          ? [
              { label: m.members_tab_topics(), value: 'topics' },
              { label: m.study_panel_practice(), value: 'practice' },
              { label: m.question_ui_question_bank(), value: 'bank' },
            ]
          : [{ label: m.learning_tab_history(), value: 'history' }]),
      ]}
      value={value}
    />
  );
}
