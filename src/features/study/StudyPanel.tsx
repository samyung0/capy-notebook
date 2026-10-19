import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import {
  invalidateStudy,
  useChapters,
  useFiles,
  useMaterials,
  useRateReviewItem,
  useSetWorkspaceStudyEnabled,
  useWorkspace,
  useWorkspaceStudy,
} from '@/api/hooks';
import type { ReviewItem, UnfinishedSession } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { CardStack, useCardStack } from '@/features/flashcards/CardStack';
import { relativeTime } from '@/features/materials/MaterialListCard';
import type { OpenItem } from '@/features/materials/openItem';
import type { Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { CheckedQuestion, QuestionItem } from '@/features/study/ReviewQuestion';
import { StepNav } from '@/features/study/StepNav';
import {
  answerStep,
  currentStep,
  nextStep,
  previousStep,
  type Steps,
  useSteps,
} from '@/features/study/steps';
import type { TabAction } from '@/features/workspace/PanelTabRow';
import {
  readingOrder,
  type WorkspaceContentItem,
} from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { reviewCard } from './ratings';

function itemTitle(item: WorkspaceContentItem): string {
  return item.type === 'file' ? item.data.name : item.data.title;
}

function ItemIcon({ item }: { item: WorkspaceContentItem }) {
  return (
    <FileIcon
      className="size-3.75 shrink-0"
      name={
        item.type === 'file'
          ? fileIconName(item.data)
          : materialIconName(item.data.type)
      }
    />
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between">
        <h3 className="t-label px-1.5 py-1.5 text-fg-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The workspace's Study tab: quick actions (read next, the whole workspace's
 * review), Quick review, done
 * per chapter, recent quiz results and the progress switch. Every section
 * hides while it has nothing to show. */
export function StudyPanel({
  workspaceId,
  renderTabRow,
  onOpenItem,
  onOpenProgress,
}: {
  workspaceId: string;
  renderTabRow: (actions: TabAction[]) => ReactNode;
  onOpenItem: (item: OpenItem) => void;
  /** Opens the workspace's Study progress page in the centre pane. */
  onOpenProgress: () => void;
}) {
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: study } = useWorkspaceStudy(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { isPending: savingEnabled, mutate: setEnabled } =
    useSetWorkspaceStudyEnabled(workspaceId);

  const loaded = !!(study && chapters && files && materials);
  const states = new Map(
    (study?.items ?? []).map((it) => [it.fileId ?? it.materialId, it.state])
  );
  const ordered = readingOrder(chapters, files, materials);
  const next = ordered.find((it) => {
    const state = states.get(it.id);
    return state !== 'done' && state !== 'removed';
  });
  const tracked = ordered.filter((it) => states.get(it.id) !== 'removed');
  // Untouched items are tracked too, so only a workspace with nothing tracked,
  // no attempts and nothing to review is empty.
  const nothingYet =
    !tracked.length && !study?.recentAttempts.length && !study?.reviewable;

  const chapterRows = [
    ...[...(chapters ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((ch) => ({ id: ch.id, name: ch.name })),
    { id: null, name: m.study_others() },
  ]
    .map((ch) => {
      const items = tracked.filter(
        (it) => (it.data.chapterId ?? null) === ch.id
      );
      return {
        ...ch,
        done: items.filter((it) => states.get(it.id) === 'done').length,
        total: items.length,
      };
    })
    .filter((ch) => ch.total > 0);

  const toggle = (
    <div className="mt-auto flex items-center justify-between gap-3 border-divider border-t px-1.5 pt-3">
      <span className="font-semibold">{m.study_track_progress()}</span>
      <Switch
        aria-label={m.study_track_progress()}
        checked={!!study?.enabled}
        disabled={savingEnabled}
        onCheckedChange={(checked) => setEnabled(checked)}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {renderTabRow([])}
      <div className="scroll-fade-y flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-3 pt-5 pb-4">
        {loaded ? (
          study.enabled ? (
            nothingYet ? (
              <>
                <p className="m-auto max-w-64 text-center text-fg-muted">
                  {m.study_nothing_yet()}
                </p>
                {toggle}
              </>
            ) : (
              <>
                <Section title={m.study_quick_actions()}>
                  <div className="flex flex-col gap-4 px-2 pt-1.5">
                    {next && (
                      <div className="flex items-center gap-2">
                        <ItemIcon item={next} />
                        <span className="line-clamp-1 flex-1 translate-y-px">
                          {itemTitle(next)}
                        </span>
                        <UnderlineLink
                          accent
                          onClick={() =>
                            onOpenItem({ id: next.id, kind: next.type })
                          }
                        >
                          {m.study_continue()}
                        </UnderlineLink>
                      </div>
                    )}
                    <WorkspaceReview
                      iconId={workspace?.iconId}
                      reviewable={study.reviewable}
                      unfinished={study.unfinished}
                      workspaceId={workspaceId}
                    />
                  </div>
                </Section>
                {/* Stays mounted through refreshes; hides itself. */}
                <QuickReview
                  items={study.quickReview}
                  workspaceId={workspaceId}
                />
                {chapterRows.length > 0 && (
                  <Section
                    aside={
                      <UnderlineLink onClick={onOpenProgress}>
                        {m.progress_all()}
                      </UnderlineLink>
                    }
                    title={m.study_done()}
                  >
                    {chapterRows.map((ch) => (
                      <div
                        className="flex items-center gap-1.5 rounded-button px-2 py-1.5"
                        key={ch.id ?? 'unfiled'}
                      >
                        <Icon
                          className={cn(
                            'shrink-0',
                            ch.done === ch.total
                              ? 'text-tint-success-fg'
                              : 'text-fg-muted'
                          )}
                          name={
                            ch.done === ch.total
                              ? 'circleCheck'
                              : ch.done
                                ? 'ellipse'
                                : 'circleDashed'
                          }
                          size={14}
                        />
                        <span className="line-clamp-1 flex-1 translate-y-px font-semibold">
                          {ch.name}
                        </span>
                        <span className="t-meta text-fg-muted">
                          {m.study_of({ done: ch.done, total: ch.total })}
                        </span>
                      </div>
                    ))}
                  </Section>
                )}
                {study.recentAttempts.length > 0 && (
                  <Section title={m.study_recent_quizzes()}>
                    {study.recentAttempts.map((a) => (
                      <Link
                        className="flex items-center gap-1.5 rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg"
                        key={a.id}
                        params={{ attemptId: a.id }}
                        to="/quizzes/attempts/$attemptId"
                      >
                        <FileIcon
                          className="size-3.75 shrink-0"
                          name={materialIconName('quiz')}
                        />
                        <span className="line-clamp-1 min-w-0 flex-1 translate-y-px">
                          {a.quizName}
                        </span>
                        <span className="t-meta shrink-0 text-fg-muted">
                          {m.study_attempt_score({
                            correct: a.correct,
                            total: a.total,
                          })}
                        </span>
                      </Link>
                    ))}
                  </Section>
                )}
                {toggle}
              </>
            )
          ) : (
            <>
              <p className="m-auto max-w-64 text-center text-fg-muted">
                {m.study_off()}
              </p>
              {toggle}
            </>
          )
        ) : (
          <SkeletonList count={5} rowHeight={36} />
        )}
      </div>
    </div>
  );
}

/** The whole workspace's review: Continue review picks up its latest
 * unfinished session, otherwise Review starts a new one. Either way the
 * session is recorded with its first answer. */
function WorkspaceReview({
  workspaceId,
  iconId,
  reviewable,
  unfinished,
}: {
  workspaceId: string;
  iconId?: string;
  reviewable: number;
  unfinished?: UnfinishedSession;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex items-start gap-2">
      {iconId ? (
        <img
          alt=""
          className="mt-0.5 size-3.75 shrink-0 rounded-[3px]"
          height={15}
          src={iconUrl(iconId)}
          width={15}
        />
      ) : (
        <span className="size-3.75 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 translate-y-px flex-col gap-1">
        <span className="line-clamp-1">{m.study_whole_workspace()}</span>
        {unfinished && (
          <span className="text-fg-muted text-xs">
            {m.study_review_progress({
              answered: unfinished.answered,
              total: unfinished.total,
              when: relativeTime(unfinished.lastAnswerAt),
            })}
          </span>
        )}
      </span>
      <UnderlineLink
        disabled={!unfinished && !reviewable}
        onClick={() =>
          navigate({
            params: { workspaceId },
            search: unfinished
              ? { from: 'workspace', session: unfinished.id }
              : { from: 'workspace', group: 'workspace' },
            to: '/learning/review/$workspaceId',
          })
        }
      >
        {unfinished ? m.learning_continue_review() : m.study_review_button()}
      </UnderlineLink>
    </div>
  );
}

type QuickPhase = 'open' | 'leaving' | 'gone';

/** The Study tab's short practice: up to four flashcards and single-part
 * quick questions, picked by the server as a suggested review would. Ratings
 * and checks are recorded like any review. The round is the list as it was
 * when it began, kept while answers refresh the summary (answered items
 * leave it); once the last item is done the section dissolves into smoke and
 * stays gone until the workspace opens again. */
function QuickReview({
  items,
  workspaceId,
}: {
  items: ReviewItem[];
  workspaceId: string;
}) {
  const [round, setRound] = useState(items);
  const [phase, setPhase] = useState<QuickPhase>('open');
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // A round can only start once there is something to practise.
  if (round.length === 0 && items.length > 0 && phase === 'open')
    setRound(items);
  if (round.length === 0 || phase === 'gone') return null;
  // Reduced motion runs no animation, so there is no end to wait for.
  const finish = () => setPhase(reduceMotion ? 'gone' : 'leaving');
  const leaving = phase === 'leaving';

  return (
    <div
      className={cn(leaving ? 'motion-smoke-collapse' : 'grid grid-rows-[1fr]')}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget) setPhase('gone');
      }}
    >
      <div
        className={cn('min-h-0', leaving && 'motion-smoke-out')}
        inert={leaving}
      >
        <QuickItems items={round} onDone={finish} workspaceId={workspaceId} />
      </div>
    </div>
  );
}

/** A card's rating, or a checked question with its key. */
type QuickRecord =
  | { rating: SrsRating }
  | { answers: Answers; question: Question };

/** One item at a time. Next skips an item to the end of the round; Previous
 * shows an answered one read only. A rated card moves on at once, and the
 * last rating keeps its card in place to dissolve with the section; a checked
 * question stays to show its result until Next. */
function QuickItems({
  items,
  onDone,
  workspaceId,
}: {
  items: ReviewItem[];
  onDone: () => void;
  workspaceId: string;
}) {
  const keyOf = (it: ReviewItem) => `${it.materialId}/${it.itemId}`;
  const steps = useSteps<QuickRecord>(items.map(keyOf));
  const [lastRating, setLastRating] = useState<SrsRating>();
  const stack = useCardStack();
  const qc = useQueryClient();
  const { mutateAsync: rateItem } = useRateReviewItem(workspaceId);
  const shown = steps.current;
  const item = shown && items.find((it) => keyOf(it) === shown.key);
  if (!item) return null;
  const record = shown.record;

  /** A card swipes away only over another card. */
  function move(after: Steps<QuickRecord>, back = false) {
    const to = currentStep(after);
    const next = to && items.find((it) => keyOf(it) === to.key);
    stack.move(
      item?.kind === 'card' && next?.kind === 'card'
        ? reviewCard(item)
        : undefined,
      back
    );
  }

  function rate(rating: SrsRating) {
    if (!item) return;
    rateItem({
      itemId: item.itemId,
      materialId: item.materialId,
      rating: SRS_RATINGS.indexOf(rating) + 1,
    }).catch(() =>
      userToast({
        id: 'quick-review-failed',
        title: m.flashcards_review_failed(),
        variant: 'error',
      })
    );
    const after = answerStep(steps.steps, { rating });
    if (!currentStep(after)) {
      setLastRating(rating);
      onDone();
      return;
    }
    move(after);
    steps.answer({ rating });
  }

  function next() {
    const after = nextStep(steps.steps);
    // Past the last checked question there is nothing left.
    if (!currentStep(after)) {
      onDone();
      return;
    }
    move(after);
    steps.next();
  }

  return (
    <Section
      aside={
        <span className="t-meta px-1.5 text-fg-muted">
          {m.study_quick_position({
            current: items.indexOf(item) + 1,
            total: items.length,
          })}
        </span>
      }
      title={m.study_quick_review()}
    >
      <div className="flex flex-col gap-2 px-1.5 pt-1">
        {item.kind === 'card' ? (
          <>
            <CardStack
              card={reviewCard(item)}
              onRate={rate}
              rated={record && 'rating' in record ? record.rating : lastRating}
              size="panel"
              stack={stack}
            />
            <p className="t-meta text-center text-fg-muted">
              {item.materialTitle}
            </p>
          </>
        ) : record && 'question' in record ? (
          <CheckedQuestion
            answers={record.answers}
            question={record.question}
            title={item.materialTitle}
          />
        ) : (
          <QuestionItem
            item={item}
            key={shown.key}
            onChecked={(graded, answers) => {
              void invalidateStudy(qc, workspaceId);
              steps.answer(
                { answers, question: graded.question },
                { stay: true }
              );
            }}
          />
        )}
        <StepNav
          canNext={shown.past || steps.steps.queue.length > 1 || !!record}
          canPrevious={steps.steps.cursor > 0}
          className="pt-2"
          onNext={next}
          onPrevious={() => {
            move(previousStep(steps.steps), true);
            steps.previous();
          }}
        />
      </div>
    </Section>
  );
}
