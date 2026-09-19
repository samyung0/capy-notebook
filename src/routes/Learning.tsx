import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAttempts, useMistakes } from '@/api/hooks';
import type { Attempt } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

function scoreTone(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 70 ? 'success' : pct >= 55 ? 'warning' : 'error';
}

function ReviewMistakesCard() {
  const { data: mistakes } = useMistakes({ errorBoundary: false });
  const navigate = useNavigate();
  const count = mistakes?.questions.length ?? 0;
  return (
    <Card
      border="solid"
      className={cn(
        'flex-row items-center gap-4 p-4.5',
        count === 0 && 'opacity-60'
      )}
      interactive={count > 0}
      onClick={() =>
        count > 0 &&
        navigate({
          params: { quizId: 'review_mistakes' },
          to: '/quizzes/$quizId/attempt',
        })
      }
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-tint-error text-tint-error-fg">
        <Icon name="help" size={20} />
      </span>
      <div className="min-w-0">
        <p className="t-card-title truncate">{m.quiz_review_mistakes()}</p>
        <p className="t-meta mt-0.5 text-fg-muted">
          {count > 0
            ? m.quiz_review_mistakes_count({ count })
            : m.quiz_review_mistakes_empty()}
        </p>
      </div>
    </Card>
  );
}

function PastAttempts() {
  const { data, fetchStatus, isLoading } = useAttempts();
  const revealRef = useLoadingReveal(isLoading);
  const navigate = useNavigate();
  if (fetchStatus === 'paused') return <QueryPausedState />;
  if (isLoading) return <SkeletonList count={6} rowHeight={52} />;
  if (!data?.length)
    return (
      <p className="py-8 text-center text-fg-muted">{m.quiz_no_attempts()}</p>
    );

  return (
    <div
      className="overflow-hidden rounded-card border border-line"
      ref={revealRef}
    >
      <div className="hidden bg-surface-hover-bg px-4 py-3 font-bold text-fg-muted text-xs uppercase tracking-wide md:flex">
        <div className="flex-[2.2]">{m.quiz_col_quiz()}</div>
        <div className="flex-[1.8]">{m.quiz_col_workspace()}</div>
        <div className="flex-1 text-center">{m.quiz_col_score()}</div>
        <div className="flex-[1.3]">{m.quiz_col_date()}</div>
        <div className="w-28" />
      </div>
      {data.map((a: Attempt) => (
        <div
          className="flex flex-col gap-2 border-divider border-t px-4 py-3 first:border-t-0 md:flex-row md:items-center"
          key={a.id}
        >
          <div className="flex-[2.2] font-semibold text-fg">{a.quizName}</div>
          <div className="flex-[1.8] text-fg-secondary text-sm">
            {a.workspaceName}
          </div>
          <div className="flex-1 md:text-center">
            <Badge tone={scoreTone(a.pct)}>
              {formatPoints(a.correct)}/{formatPoints(a.total)} · {a.pct}%
            </Badge>
          </div>
          <div className="flex-[1.3] text-fg-muted text-sm">
            {new Date(a.takenAt).toLocaleDateString()}
          </div>
          <div className="md:w-28">
            <Button
              onClick={() =>
                navigate({
                  params: { attemptId: a.id },
                  to: '/quizzes/attempts/$attemptId',
                })
              }
              size="sm"
              variant="outline"
            >
              {m.quiz_check_result()}
            </Button>
          </div>
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
        <ReviewMistakesCard />
        <PastAttempts />
      </div>
    </PanelWithInvertedRadius>
  );
}
