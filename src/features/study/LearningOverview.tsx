import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useLearningOverview } from '@/api/hooks';
import type { LearningRow, LearningWorkspace } from '@/api/types';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { InkBook } from '@/features/workspace/WorkspaceEmpty';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { questionsLabel } from './practice/practiceText';
import { groupName, itemCount, REVIEW_MODE, reviewReason } from './reviewText';
import { LabelChip } from './topicLabels';

/** Learning → Overview (Epo 2026-11-04, canvas board A): what to do next across
 * workspaces, then how each stands. Every row comes from a rule on the server
 * (`LearningOverview`), and the workspace's own actions live on its Dashboard. */
export function LearningOverviewTab() {
  const { data, fetchStatus, isLoading } = useLearningOverview();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  if (waitsForConnection(fetchStatus, data)) return <QueryPausedState />;
  if (isLoading) return <SkeletonList count={5} rowHeight={72} />;
  if (!data) return null;
  const openWorkspace = (workspaceId: string) =>
    navigate({ params: { workspaceId }, to: '/workspaces/$workspaceId' });
  if (!data.next.length && !data.workspaces.length && !data.teaches.length)
    return (
      <div
        className="flex flex-col items-center gap-4 py-16 text-center"
        ref={revealRef}
      >
        <InkBook />
        <p className="t-subtitle">{m.review_no_quizzes()}</p>
        <Button onClick={() => navigate({ to: '/' })} variant="outline">
          {m.learning_go_workspaces()}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-6" ref={revealRef}>
      {data.next.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 className="t-subtitle">{m.learning_next()}</h2>
            <Button
              onClick={() =>
                navigate({ search: { tab: 'study' }, to: '/settings' })
              }
              size="sm"
              variant="outline"
            >
              {m.review_preferences()}
            </Button>
          </div>
          {data.next.map((row) => (
            <NextRow key={rowKey(row)} row={row} />
          ))}
        </section>
      )}
      {data.workspaces.length > 0 && (
        <section>
          <h2 className="t-subtitle mb-1">{m.learning_workspaces()}</h2>
          {data.workspaces.map((ws) => (
            <WorkspaceRow
              key={ws.workspaceId}
              onOpen={() => openWorkspace(ws.workspaceId)}
              ws={ws}
            />
          ))}
        </section>
      )}
      {data.teaches.length > 0 && (
        <section>
          <h2 className="t-subtitle mb-1">{m.learning_you_teach()}</h2>
          {data.teaches.map((ws) => (
            <RowButton
              className="grid-cols-[32px_minmax(0,1fr)_auto] items-center"
              key={ws.workspaceId}
              onClick={() =>
                navigate({
                  params: { workspaceId: ws.workspaceId },
                  search: { study: 'practice' as const },
                  to: '/workspaces/$workspaceId',
                })
              }
            >
              <WorkspaceIcon iconId={ws.iconId} />
              <span className="truncate font-semibold">{ws.name}</span>
              <span className="t-meta text-fg-secondary">
                {ws.members === 1
                  ? m.workspace_members_one()
                  : m.workspace_members_count({ count: ws.members })}
              </span>
            </RowButton>
          ))}
        </section>
      )}
    </div>
  );
}

/** "This week: 41 questions, 18 cards"; neither when nothing was answered. */
export function weekLine(questions: number, cards: number) {
  const parts = [
    questions > 0 && questionsLabel(questions),
    cards > 0 &&
      (cards === 1
        ? m.learning_cards_one()
        : m.learning_cards({ count: cards })),
  ].filter(Boolean);
  return parts.length ? m.learning_week({ parts: parts.join(', ') }) : '';
}

const rowKey = (r: LearningRow) =>
  [
    r.kind,
    r.sessionId ?? r.materialId ?? r.workspaceId,
    r.suggestion?.group,
    r.suggestion?.topicId,
  ].join('/');

/** A whole row is the link: it hovers as one, square, bleeding past the
 * dividers as the Review tab's rows did. */
function RowButton({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        '-mx-2 grid w-[calc(100%+1rem)] gap-x-3.5 border-divider border-t px-2 py-2.5 text-left hover:bg-surface-hover-bg focus-visible:outline-2 focus-visible:outline-action',
        className
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function WorkspaceIcon({ iconId }: { iconId: string }) {
  return (
    <img
      alt=""
      className="size-8 rounded-button"
      height={32}
      src={iconUrl(iconId)}
      width={32}
    />
  );
}

/** What the row is: a quiz or set by its file icon, a review by its arrow. */
function RowIcon({ row }: { row: LearningRow }) {
  if (row.kind === 'quiz' || row.kind === 'start')
    return (
      <FileIcon
        className="mt-px size-5 shrink-0"
        name={materialIconName(
          row.materialKind === 'flashcards' ? 'flashcards' : 'quiz'
        )}
      />
    );
  return (
    <Icon className="mt-px shrink-0 text-fg-muted" name="retry" size={20} />
  );
}

function NextRow({ row }: { row: LearningRow }) {
  const navigate = useNavigate();
  const { suggestion: s, workspaceName, workspaceId } = row;
  function open() {
    if (row.kind === 'session')
      return navigate({
        params: { workspaceId },
        search: { from: 'review' as const, session: row.sessionId },
        to: '/learning/review/$workspaceId',
      });
    // The start dialog over the workspace's Practice, as on its Dashboard.
    if (s)
      return navigate({
        params: { workspaceId },
        search: {
          group: s.group,
          reviewMode: s.mode,
          study: 'practice' as const,
          topicId: s.topicId,
        },
        to: '/workspaces/$workspaceId',
      });
    if (row.materialKind === 'flashcards')
      return navigate({
        params: { flashcardSetId: row.materialId ?? '' },
        to: '/flashcards/$flashcardSetId',
      });
    return navigate({
      params: { quizId: row.materialId ?? '' },
      to: '/quizzes/$quizId/attempt',
    });
  }
  const group = groupName(
    (s?.group ?? row.group ?? 'workspace') as 'topic' | 'others' | 'workspace',
    s?.topicName ?? row.topicName
  );
  const title = row.title || group || workspaceName;
  const when = row.at ? relativeTime(row.at) : '';
  return (
    <RowButton className="grid-cols-[20px_minmax(0,1fr)]" onClick={open}>
      <RowIcon row={row} />
      <span className="min-w-0">
        <span className="flex min-w-0 flex-col sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2">
          <span className="truncate font-semibold">{title}</span>
          {title !== workspaceName && (
            <span className="truncate text-fg-muted text-xs">
              {workspaceName}
            </span>
          )}
        </span>
        <span className="block text-fg-secondary text-sm">
          {row.kind === 'session' &&
            m.learning_continue_session({
              answered: row.answered,
              total: row.total,
              when,
            })}
          {row.kind === 'quiz' &&
            m.learning_continue_quiz({
              answered: row.answered,
              total: row.total,
              when,
            })}
          {row.kind === 'start' &&
            `${m.learning_not_started()} · ${
              row.materialKind === 'flashcards'
                ? row.total === 1
                  ? m.learning_cards_one()
                  : m.learning_cards({ count: row.total })
                : questionsLabel(row.total)
            }`}
          {s && reviewReason(s)}
        </span>
        {s && (
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            <span
              className={cn(
                'inline-flex items-center gap-1 font-bold',
                REVIEW_MODE[s.mode].className
              )}
            >
              <Icon
                className="size-3.5 -translate-y-px"
                name={REVIEW_MODE[s.mode].icon}
              />
              {REVIEW_MODE[s.mode].label()}
            </span>
            <span className="text-fg-muted">{itemCount(s.items)}</span>
          </span>
        )}
      </span>
    </RowButton>
  );
}

function WorkspaceRow({
  onOpen,
  ws,
}: {
  onOpen: () => void;
  ws: LearningWorkspace;
}) {
  const tried = m.learning_items_tried({ items: ws.items, tried: ws.tried });
  const notStarted = ws.labels.every((l) => l.label === 'not_started');
  const when = ws.lastPractisedAt ? relativeTime(ws.lastPractisedAt) : '';
  return (
    <RowButton
      className="grid-cols-[32px_minmax(0,1fr)] items-start md:grid-cols-[32px_200px_minmax(0,1fr)_150px_110px] md:items-center"
      onClick={onOpen}
    >
      <WorkspaceIcon iconId={ws.iconId} />
      <span className="flex min-w-0 items-baseline justify-between gap-2 md:contents">
        <span className="truncate font-semibold md:self-center">{ws.name}</span>
        {when && (
          <span className="t-meta shrink-0 text-fg-muted md:hidden">
            {when}
          </span>
        )}
      </span>
      <span
        className={cn(
          'col-start-2 mt-1 flex flex-wrap gap-1 md:col-start-auto md:mt-0',
          notStarted && 'hidden md:flex'
        )}
      >
        {ws.labels.map((l) => (
          <LabelChip count={l.count} key={l.label} label={l.label} />
        ))}
      </span>
      <span className="t-meta col-start-2 mt-1 whitespace-nowrap text-fg-secondary md:col-start-auto md:mt-0">
        {notStarted && (
          <span className="md:hidden">{`${m.learning_not_started()} · `}</span>
        )}
        {tried}
      </span>
      <span className="t-meta hidden text-fg-muted md:block">{when}</span>
    </RowButton>
  );
}
