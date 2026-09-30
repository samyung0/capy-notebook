import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAttempts } from '@/api/hooks';
import type { Attempt } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

function scoreTone(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 70 ? 'success' : pct >= 55 ? 'warning' : 'error';
}

function PastAttempts() {
  const { data, fetchStatus, isLoading } = useAttempts();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  // Attempts of a deleted quiz have no quiz to redo.
  const redo = (quizId: string | null) =>
    quizId
      ? [
          {
            icon: 'refresh' as const,
            label: m.quiz_redo(),
            onClick: () =>
              navigate({ params: { quizId }, to: '/quizzes/$quizId/attempt' }),
          },
        ]
      : [];
  if (fetchStatus === 'paused') return <QueryPausedState />;
  if (isLoading) return <SkeletonList count={6} rowHeight={52} />;
  if (!data?.length)
    return (
      <p className="py-8 text-center text-fg-muted">{m.quiz_no_attempts()}</p>
    );

  // Phones keep the table with Quiz, Score and the action menu; md adds
  // Workspace and Date.
  return (
    <div
      className="overflow-hidden rounded-card border border-line"
      ref={revealRef}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_2.25rem] items-center gap-3 bg-surface-hover-bg px-4 py-3 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_7rem_7rem_2.25rem]">
        <div>{m.quiz_col_quiz()}</div>
        <div className="hidden md:block">{m.quiz_col_workspace()}</div>
        <div className="md:text-center">{m.quiz_col_score()}</div>
        <div className="hidden md:block">{m.quiz_col_date()}</div>
        <div />
      </div>
      {data.map((a: Attempt) => (
        <div
          className="grid grid-cols-[minmax(0,1fr)_auto_2.25rem] items-center gap-3 border-divider border-t py-2 pr-2 pl-4 first:border-t-0 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_7rem_7rem_2.25rem]"
          key={a.id}
        >
          <div className="truncate font-semibold text-fg">{a.quizName}</div>
          <div className="hidden truncate text-fg-secondary text-sm md:block">
            {a.workspaceName}
          </div>
          <div className="md:text-center">
            <Badge tone={scoreTone(a.pct)}>
              {formatPoints(a.correct)}/{formatPoints(a.total)}
              <span className="hidden sm:inline"> · {a.pct}%</span>
            </Badge>
          </div>
          <div className="hidden text-fg-muted text-sm md:block">
            {new Date(a.takenAt).toLocaleDateString()}
          </div>
          <Menu
            items={[
              {
                icon: 'list',
                label: m.quiz_check_result(),
                onClick: () =>
                  navigate({
                    params: { attemptId: a.id },
                    to: '/quizzes/attempts/$attemptId',
                  }),
              },
              ...redo(a.materialId),
            ]}
          />
        </div>
      ))}
    </div>
  );
}

export default function Learning() {
  const [tab, setTab] = useState('results');
  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_learning()} />
      <div className="px-6 pt-4">
        <Tabs
          onChange={setTab}
          tabs={[{ label: m.learning_tab_results(), value: 'results' }]}
          value={tab}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-5">
        <PastAttempts />
      </div>
    </PanelWithInvertedRadius>
  );
}
