import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useAttempts,
  useCloneQuiz,
  useCreateQuiz,
  useDeleteQuiz,
  useMistakes,
  useQuizzes,
  useUpdateQuiz,
} from '@/api/hooks';
import type { Attempt, Quiz } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import { SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid, SkeletonList } from '@/components/ui/feedback';
import { Tabs } from '@/components/ui/Tabs';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { usePortals } from '@/stores/portals';

function scoreTone(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 70 ? 'success' : pct >= 55 ? 'warning' : 'error';
}

function ReviewMistakesCard() {
  const { data: mistakes } = useMistakes();
  const navigate = useNavigate();
  const count = mistakes?.questions.length ?? 0;
  return (
    <Card
      border="solid"
      className={cn('gap-3 p-4.5 xl:p-5.5', count === 0 && 'opacity-60')}
      interactive={count > 0}
      onClick={() =>
        count > 0 &&
        navigate({
          params: { quizId: 'review_mistakes' },
          to: '/quizzes/$quizId/attempt',
        })
      }
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-card bg-tint-error text-tint-error-fg">
        <Icon name="help" size={20} />
      </span>
      <p className="t-card-title mt-3 truncate">{m.quiz_review_mistakes()}</p>
      <p className="t-meta mt-1 text-fg-muted">
        {count > 0
          ? m.quiz_review_mistakes_count({ count })
          : m.quiz_review_mistakes_empty()}
      </p>
    </Card>
  );
}

function AllQuizzes() {
  const { data, isLoading } = useQuizzes();
  const navigate = useNavigate();
  const del = useDeleteQuiz();
  const clone = useCloneQuiz();
  const update = useUpdateQuiz();
  const openConfirm = usePortals((s) => s.openConfirm);
  const [info, setInfo] = useState<Quiz | null>(null);
  const [sharing, setSharing] = useState<Quiz | null>(null);

  if (isLoading) return <SkeletonCardGrid cardHeight={150} count={6} />;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ReviewMistakesCard />
        {data?.map((q) => (
          <Card
            border="solid"
            className="relative h-full gap-3 p-4.5 xl:p-5.5"
            interactive
            key={q.id}
            onClick={() => setInfo(q)}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-card bg-tint-accent-1 text-tint-accent-1-fg">
              <Icon name="quiz" size={20} />
            </span>
            <p className="t-card-title mt-3 truncate">{q.name}</p>
            <span className="mt-1 flex items-center gap-1 text-fg-muted text-xs">
              <Icon name="book" size={13} /> {q.workspaceName || 'Standalone'}
            </span>
            <p className="t-meta mt-1 text-fg-muted">
              {q.questions.length} questions ·{' '}
              {q.chapters.join(', ') || 'All chapters'}
            </p>
            <div
              className="absolute top-3 right-3"
              onClick={(e) => e.stopPropagation()}
            >
              <Menu
                items={[
                  {
                    icon: 'settings',
                    label: m.action_edit(),
                    onClick: () =>
                      navigate({
                        params: { quizId: q.id },
                        to: '/quizzes/$quizId/edit',
                      }),
                  },
                  {
                    icon: 'quiz',
                    label: 'Start quiz',
                    onClick: () =>
                      navigate({
                        params: { quizId: q.id },
                        to: '/quizzes/$quizId/attempt',
                      }),
                  },
                  {
                    icon: 'link',
                    label: 'Share',
                    onClick: () => setSharing(q),
                  },
                  {
                    icon: 'plus',
                    label: 'Clone',
                    onClick: () => clone.mutate(q.id),
                  },
                  {
                    danger: true,
                    icon: 'trash',
                    label: m.action_delete(),
                    onClick: () =>
                      openConfirm({
                        body: m.confirm_delete_body(),
                        onConfirm: () => del.mutate(q.id),
                        title: m.confirm_delete_title({ name: q.name }),
                      }),
                  },
                ]}
              />
            </div>
          </Card>
        ))}
      </div>

      <SimpleDialog
        footer={
          info && (
            <>
              <Button onClick={() => setInfo(null)} variant="ghost">
                Cancel
              </Button>
              <Button
                iconRight="arrowRight"
                onClick={() =>
                  navigate({
                    params: { quizId: info.id },
                    to: '/quizzes/$quizId/attempt',
                  })
                }
              >
                {m.quiz_start()}
              </Button>
            </>
          )
        }
        onClose={() => setInfo(null)}
        open={!!info}
        title={info?.name}
      >
        {info && (
          <div className="flex flex-col gap-2">
            <p>
              <b>{info.questions.length}</b> questions across{' '}
              {info.chapters.length || 'all'} chapters.
            </p>
            <p className="text-fg-secondary">
              Workspace: {info.workspaceName || 'Standalone'}
            </p>
            {(info.timeLimitMin ?? 0) > 0 && (
              <p className="text-fg-secondary">
                Time limit: {info.timeLimitMin} min
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {[...new Set(info.questions.map((q) => q.type))].map((t) => (
                <Badge key={t} size="sm">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </SimpleDialog>
      {sharing && (
        <ShareDialog
          link={`/share/quizzes/${sharing.id}`}
          onClose={() => setSharing(null)}
          onPrivacyChange={async (privacy) => {
            const quiz = await update.mutateAsync({ id: sharing.id, privacy });
            setSharing(quiz);
          }}
          open
          privacy={sharing.privacy}
          saving={update.isPending}
          title={`Share ${sharing.name}`}
        />
      )}
    </>
  );
}

function PastAttempts() {
  const { data, isLoading } = useAttempts();
  const navigate = useNavigate();
  if (isLoading) return <SkeletonList count={6} rowHeight={52} />;
  if (!data?.length)
    return <p className="py-8 text-center text-fg-muted">No attempts yet.</p>;

  return (
    <div className="overflow-hidden rounded-card border border-line">
      {/* desktop header */}
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
              {a.correct}/{a.total} · {a.pct}%
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
              Check result
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Quizzes() {
  const [tab, setTab] = useState('all');
  const createQuiz = useCreateQuiz();
  const navigate = useNavigate();

  function newQuiz() {
    createQuiz.mutate(
      { name: 'Untitled quiz', questions: [] },
      {
        onSuccess: (quiz) =>
          navigate({
            params: { quizId: quiz.id },
            to: '/quizzes/$quizId/edit',
          }),
      }
    );
  }

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <IconButton
            disabled={createQuiz.isPending}
            icon="plus"
            label={m.action_new_quiz()}
            onClick={newQuiz}
            size="lg"
            variant="page"
          />
        }
        title={m.nav_quizzes()}
      />
      <div className="px-6 pt-4">
        <Tabs
          onChange={setTab}
          tabs={[
            { label: m.quiz_tab_all(), value: 'all' },
            { label: m.quiz_tab_attempts(), value: 'attempts' },
          ]}
          value={tab}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {tab === 'all' ? <AllQuizzes /> : <PastAttempts />}
      </div>
    </PanelWithInvertedRadius>
  );
}
