import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { Attempt, ItemAttempts } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { FileIconName } from '@/lib/fileIcons';
import { attemptMinutes, resultLink, scoreText } from './attempts';
import { StudyMark, type StudyState } from './studyItems';

/* The Study page's list (human/study-progress.md 2026-10-25): sections of
   rows, a workspace's chapters on Default Plan or a plan's chapter groups,
   each an accordion of its files and materials. */

/** One file or material as the list shows it, from this workspace's own
 * data or, for a plan step elsewhere, from that workspace's tracked items. */
export type StudyRow = {
  id: string;
  type: 'file' | 'material';
  /** The file's kind or the material's type. */
  kind: string;
  title: string;
  icon: FileIconName;
  /** The workspace it lives in. */
  workspaceId: string;
  state?: StudyState;
  /** When its state last changed: when it was marked read. */
  readAt?: string;
  attempts?: ItemAttempts;
  /** Mark as read and Stop tracking for this workspace's items, then on a
   * plan Remove from plan. */
  menuItems?: MenuItem[];
};

export type StudySection = {
  key: string;
  name: string;
  /** Muted after the name: the workspace of a group from elsewhere. */
  aside?: string;
  /** The rows the filters leave. */
  rows: StudyRow[];
  done: number;
  total: number;
  /** Steps in a workspace the user can no longer open. */
  locked?: boolean;
  /** The group's plan action (Remove from plan). */
  menu?: MenuItem[];
};

export function SectionList({
  sections,
  isOpen,
  onToggle,
  onOpenRow,
  workspaceId,
}: {
  sections: StudySection[];
  isOpen: (key: string) => boolean;
  onToggle: (key: string) => void;
  onOpenRow: (row: StudyRow) => void;
  workspaceId: string;
}) {
  const [results, setResults] = useState<ReadonlySet<string>>(new Set());
  const toggleResults = (id: string) =>
    setResults((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="mt-2 border-divider border-b">
      {sections.map((s) => {
        const expanded = !s.locked && isOpen(s.key);
        return (
          <section className="border-divider border-t" key={s.key}>
            <div className="group relative flex items-center gap-3 px-1.5 py-3 hover:bg-surface-hover-bg">
              {!s.locked && <ChapterMark done={s.done} total={s.total} />}
              <button
                aria-expanded={s.locked ? undefined : expanded}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset disabled:cursor-default"
                disabled={s.locked}
                onClick={() => onToggle(s.key)}
                type="button"
              >
                <span
                  className={cn(
                    'min-w-0 truncate font-semibold',
                    s.locked && 'font-normal text-fg-muted'
                  )}
                >
                  {s.name}
                </span>
                {s.aside && (
                  <span className="t-meta min-w-0 shrink-[2] truncate text-fg-muted">
                    {s.aside}
                  </span>
                )}
              </button>
              {!s.locked && s.total > 0 && (
                <span className="t-meta shrink-0 text-fg-muted">
                  {m.learning_done_of({ done: s.done, total: s.total })}
                </span>
              )}
              {/* The end column the rows' marks share: the chevron, giving
                  way to the step's ⋮ from md (phones show both). */}
              <div className="flex shrink-0 items-center md:grid md:w-9 md:place-items-center md:[grid-template-areas:'end']">
                {!s.locked && (
                  <Icon
                    className={cn(
                      'motion-accordion-chevron shrink-0 text-fg-muted md:[grid-area:end]',
                      s.menu &&
                        'transition-opacity ease-(--motion-ease-smooth-out) md:group-has-data-[state=open]:opacity-0 md:group-has-focus-visible:opacity-0 md:group-hover:opacity-0',
                      !expanded && '-rotate-90'
                    )}
                    name="chevronDown"
                    size={16}
                  />
                )}
                {s.menu && (
                  <div className="relative z-10 -my-2 transition-opacity ease-(--motion-ease-smooth-out) md:opacity-0 md:group-has-data-[state=open]:opacity-100 md:group-has-focus-visible:opacity-100 md:group-hover:opacity-100 md:[grid-area:end]">
                    <Menu items={s.menu} />
                  </div>
                )}
              </div>
            </div>
            {!s.locked && (
              <div
                className="motion-accordion"
                data-open={expanded}
                inert={!expanded}
              >
                <div>
                  {s.rows.map((row) => (
                    <ProgressRow
                      expanded={results.has(row.id)}
                      indent
                      key={row.id}
                      onOpen={() => onOpenRow(row)}
                      onToggle={() => toggleResults(row.id)}
                      row={row}
                      workspaceId={workspaceId}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A chapter's progress: a check once every tracked item is done, else a
 * ring filled by the share done, dashed while nothing is. */
function ChapterMark({ done, total }: { done: number; total: number }) {
  if (total > 0 && done === total)
    return (
      <Icon
        className="shrink-0 text-tint-success-fg"
        name="circleCheck"
        size={18}
      />
    );
  // The fill is a thick stroke on a half-radius circle, drawn from the top.
  const length = 2 * Math.PI * 4;
  return (
    <svg
      aria-hidden
      className={cn(
        'size-4.5 shrink-0',
        done ? 'text-fg-secondary' : 'text-line-strong'
      )}
      viewBox="0 0 20 20"
    >
      <circle
        cx="10"
        cy="10"
        fill="none"
        r="8"
        stroke="currentColor"
        strokeDasharray={done ? undefined : '3 2.6'}
        strokeWidth="1.8"
      />
      {done > 0 && (
        <circle
          cx="10"
          cy="10"
          fill="none"
          r="4"
          stroke="currentColor"
          strokeDasharray={`${(done / total) * length} ${length}`}
          strokeWidth="8"
          transform="rotate(-90 10 10)"
        />
      )}
    </svg>
  );
}

function ProgressRow({
  row,
  expanded,
  indent = false,
  onOpen,
  onToggle,
  workspaceId,
}: {
  row: StudyRow;
  expanded: boolean;
  /** Inside a chapter: the icon under the chapter's name. */
  indent?: boolean;
  onOpen: () => void;
  onToggle: () => void;
  workspaceId: string;
}) {
  const { attempts, state } = row;
  const latest = attempts?.recent[0];
  const menu = row.menuItems ?? [];
  return (
    <div className="border-divider border-t">
      <div
        className={cn(
          'group relative flex items-center gap-3 py-2.5 pr-1.5 hover:bg-surface-hover-bg',
          indent ? 'pl-9' : 'pl-1.5'
        )}
      >
        <FileIcon className="size-4 shrink-0" name={row.icon} />
        {/* Name and meta share one line; the meta gives way first. */}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {latest ? (
            <Link
              className={cn(
                'min-w-0 truncate text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset',
                state === 'removed' && 'text-fg-muted'
              )}
              {...resultLink(latest)}
            >
              {row.title}
            </Link>
          ) : (
            <button
              className={cn(
                'min-w-0 truncate text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset',
                state === 'removed' && 'text-fg-muted'
              )}
              onClick={onOpen}
              type="button"
            >
              {row.title}
            </button>
          )}
          <span className="t-meta min-w-0 shrink-[2] truncate text-fg-muted">
            {rowMeta(row)}
          </span>
        </div>
        {latest && (
          <span className="whitespace-nowrap text-fg-secondary text-sm">
            {scoreText(latest)}
          </span>
        )}
        {attempts && attempts.count > 0 && (
          <button
            aria-expanded={expanded}
            aria-label={m.progress_toggle_results({ name: row.title })}
            className="relative z-10 grid size-7 shrink-0 place-items-center rounded-button text-fg-muted hover:bg-surface-dark"
            onClick={onToggle}
            type="button"
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} />
          </button>
        )}
        {/* From md the mark sits where the hover ⋮ appears and gives way
            to it; phones, without hover, show both. */}
        <div className="flex shrink-0 items-center md:grid md:w-9 md:place-items-center md:[grid-template-areas:'end']">
          <StudyMark
            className={cn(
              'md:[grid-area:end]',
              menu.length > 0 &&
                'transition-opacity ease-(--motion-ease-smooth-out) md:group-has-data-[state=open]:opacity-0 md:group-has-focus-visible:opacity-0 md:group-hover:opacity-0'
            )}
            state={state}
          />
          {menu.length > 0 && (
            <div className="relative z-10 -my-2 transition-opacity ease-(--motion-ease-smooth-out) md:opacity-0 md:group-has-data-[state=open]:opacity-100 md:group-has-focus-visible:opacity-100 md:group-hover:opacity-100 md:[grid-area:end]">
              <Menu items={menu} />
            </div>
          )}
        </div>
      </div>
      {expanded && attempts && (
        <Results
          attempts={attempts}
          indent={indent}
          kind={row.kind}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
  });

/** "Read 9 Oct", or "3 attempts · 10 questions · last 16 Oct". */
function rowMeta({ attempts, kind, readAt, state }: StudyRow) {
  if (state === 'removed') return m.progress_not_tracked();
  if (!attempts) {
    return state === 'done' && readAt
      ? m.progress_read_on({ date: shortDate(readAt) })
      : state === 'done'
        ? m.study_state_done()
        : m.progress_not_read();
  }
  const quiz = kind === 'quiz';
  const size = quiz
    ? attempts.size === 1
      ? m.question_ui_one_question()
      : m.question_ui_question_count({ count: attempts.size })
    : attempts.size === 1
      ? m.progress_one_card()
      : m.material_ref_cards({ count: attempts.size });
  const latest = attempts.recent[0];
  if (!latest)
    return [
      quiz ? m.progress_not_attempted() : m.progress_not_studied(),
      size,
    ].join(' · ');
  return [
    attempts.count === 1
      ? m.progress_one_attempt()
      : m.progress_attempts({ count: attempts.count }),
    size,
    m.progress_last({ date: shortDate(latest.takenAt) }),
  ].join(' · ');
}

/** The last three results, each opening its result page, then All results
 * filtered by the workspace and the item's kind. */
function Results({
  attempts,
  indent,
  kind,
  workspaceId,
}: {
  attempts: ItemAttempts;
  indent: boolean;
  /** The quiz's or set's kind, for All results' filter. */
  kind: string;
  workspaceId: string;
}) {
  return (
    <ol
      className={cn(
        'mb-2 border-divider border-l-2 pl-3.5',
        indent ? 'ml-9' : 'ml-1.5'
      )}
    >
      {attempts.recent.map((a: Attempt, i) => (
        <li
          className="relative flex items-center gap-3.5 px-1.5 py-1.5 hover:bg-surface-hover-bg"
          key={a.id}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {m.progress_attempt_n({ n: attempts.count - i })}
            </p>
            <p className="t-meta text-fg-muted">
              {[shortDate(a.takenAt), a.startedAt && attemptMinutes(a)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <span className="whitespace-nowrap text-fg-secondary text-sm">
            {scoreText(a)}
          </span>
          <UnderlineLink asChild noArrow>
            <Link className="after:absolute after:inset-0" {...resultLink(a)}>
              {m.quiz_check_result()}
            </Link>
          </UnderlineLink>
        </li>
      ))}
      {attempts.count > 0 && (
        <li className="py-1.5">
          <UnderlineLink asChild>
            <Link
              search={{ kind, tab: 'results', workspace: workspaceId }}
              to="/learning"
            >
              {m.progress_see_all_results()}
            </Link>
          </UnderlineLink>
        </li>
      )}
    </ol>
  );
}
