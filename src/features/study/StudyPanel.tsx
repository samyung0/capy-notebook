import { Link, useNavigate } from '@tanstack/react-router';
import { type CSSProperties, type ReactNode, useState } from 'react';
import {
  useChapters,
  useFiles,
  useMaterials,
  useRateReviewItem,
  useSetWorkspaceStudyEnabled,
  useWorkspace,
  useWorkspaceStudy,
} from '@/api/hooks';
import type { ReviewItem, ReviewSuggestion } from '@/api/types';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { userToast } from '@/components/ui/userToast';
import { CardStack, useCardStack } from '@/features/flashcards/CardStack';
import type { OpenItem } from '@/features/materials/openItem';
import { MiniTrail } from '@/features/questions/trailMap/TrailMap';
import { StepNav } from '@/features/study/StepNav';
import { currentStep, useSteps } from '@/features/study/steps';
import '@/features/study/railMap/railMap.css';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import type { TabAction } from '@/features/workspace/PanelTabRow';
import {
  readingOrder,
  type WorkspaceContentItem,
} from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { coverInk } from '@/lib/coverInk';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { reviewCard } from './ratings';
import { groupName, REVIEW_MODE, reviewReason } from './reviewText';

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

/** The workspace's Study tab: quick actions (read next, review), Quick review, done
 * per chapter, recent quiz results and the progress switch. Every section
 * hides while it has nothing to show. */
export function StudyPanel({
  workspaceId,
  renderTabRow,
  onOpenItem,
}: {
  workspaceId: string;
  renderTabRow: (actions: TabAction[]) => ReactNode;
  onOpenItem: (item: OpenItem) => void;
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
  const doneCount = tracked.filter((it) => states.get(it.id) === 'done').length;
  const cover = coverInk(workspace?.cover);
  const nothingYet =
    !study?.items.length && !study?.recentAttempts.length && !study?.reviewable;

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
                {(next || study.reviewable > 0) && (
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
                      {study.reviewable > 0 && (
                        <div>
                          <div className="flex items-start gap-2">
                            <Icon
                              className={cn(
                                'mt-1 shrink-0 -translate-y-px',
                                study.suggestion
                                  ? REVIEW_MODE[study.suggestion.mode].className
                                  : 'text-fg-muted'
                              )}
                              name={
                                study.suggestion
                                  ? REVIEW_MODE[study.suggestion.mode].icon
                                  : 'refresh'
                              }
                              size={15}
                            />
                            {study.suggestion ? (
                              <span className="flex min-w-0 flex-1 translate-y-px flex-col gap-1">
                                <span>
                                  {groupName(
                                    study.suggestion.group,
                                    study.suggestion.chapterName
                                  ) || study.suggestion.workspaceName}
                                </span>
                                <span className="text-fg-muted text-xs">
                                  {reviewReason(study.suggestion)}
                                </span>
                              </span>
                            ) : (
                              <>
                                <span className="flex-1 translate-y-px">
                                  {m.study_refresh_knowledge()}
                                </span>
                                <span className="translate-y-px text-fg-secondary text-sm">
                                  {m.study_of({
                                    done: doneCount,
                                    total: tracked.length,
                                  })}
                                </span>
                              </>
                            )}
                          </div>
                          {/* Total progress, done of tracked: skipping items doesn't move it. */}
                          <div className="mt-1.5 flex items-center justify-between gap-4 pl-6">
                            <div
                              className={cn(
                                'min-w-0 max-w-[240px] flex-1',
                                'rail-trail',
                                cover && 'rail-colour'
                              )}
                              style={{ '--cover-ink': cover } as CSSProperties}
                            >
                              <MiniTrail
                                answered={doneCount}
                                topicId={workspaceId}
                                total={Math.max(tracked.length, 1)}
                              />
                            </div>
                            <ReviewLink
                              suggestion={study.suggestion}
                              workspaceId={workspaceId}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </Section>
                )}
                {study.quickReview.length > 0 && (
                  <QuickReview
                    items={study.quickReview}
                    workspaceId={workspaceId}
                  />
                )}
                {chapterRows.length > 0 && (
                  <Section title={m.study_done()}>
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
                          {' · '}
                          {new Date(a.takenAt).toLocaleDateString()}
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

/** Opens the suggested review, or the whole workspace's without one; Back
 * returns to the workspace. */
function ReviewLink({
  workspaceId,
  suggestion,
}: {
  workspaceId: string;
  suggestion?: ReviewSuggestion;
}) {
  const navigate = useNavigate();
  return (
    <UnderlineLink
      onClick={() =>
        navigate({
          params: { workspaceId },
          search: {
            chapterId: suggestion?.chapterId,
            from: 'workspace',
            group: suggestion?.group ?? 'workspace',
            reviewMode: suggestion?.mode,
          },
          to: '/learning/review/$workspaceId',
        })
      }
    >
      {m.study_review_button()}
    </UnderlineLink>
  );
}

/** One missed flashcard at a time; a rating is recorded like any review
 * rating, so a card rated Good drops down the list on the next refresh. Next
 * skips a card to the end of the round; Previous shows a rated one read only. */
function QuickReview({
  items,
  workspaceId,
}: {
  items: ReviewItem[];
  workspaceId: string;
}) {
  // The list as it was when this round began: ratings refresh the summary,
  // and the round should not reshuffle under the learner.
  const [round, setRound] = useState(items);
  const keyOf = (it: ReviewItem) => `${it.materialId}/${it.itemId}`;
  const steps = useSteps<SrsRating>(round.map(keyOf));
  const stack = useCardStack();
  const { mutateAsync: rateItem } = useRateReviewItem(workspaceId);
  const shown = steps.current;
  const card = shown && round.find((it) => keyOf(it) === shown.key);
  if (!card) return null;

  function rate(rating: SrsRating) {
    if (!card) return;
    rateItem({
      itemId: card.itemId,
      materialId: card.materialId,
      rating: SRS_RATINGS.indexOf(rating) + 1,
    }).catch(() =>
      userToast({
        id: 'quick-review-failed',
        title: m.flashcards_review_failed(),
        variant: 'error',
      })
    );
    stack.move(reviewCard(card));
    // A finished round starts over on the list as it is now.
    if (!currentStep(steps.answer(rating))) {
      setRound(items);
      steps.reset(items.map(keyOf));
    }
  }

  return (
    <Section
      aside={
        <span className="t-meta px-1.5 text-fg-muted">
          {m.study_quick_position({
            current: round.indexOf(card) + 1,
            total: round.length,
          })}
        </span>
      }
      title={m.study_quick_review()}
    >
      <div className="flex flex-col gap-2 px-1.5 pt-1">
        <CardStack
          card={reviewCard(card)}
          compact
          onRate={rate}
          rated={shown.record}
          stack={stack}
        />
        <p className="t-meta text-center text-fg-muted">{card.materialTitle}</p>
        <StepNav
          canNext={shown.past || steps.steps.queue.length > 1}
          canPrevious={steps.steps.cursor > 0}
          className="pt-2"
          onNext={() => {
            stack.move(reviewCard(card));
            steps.next();
          }}
          onPrevious={() => {
            stack.move(reviewCard(card), true);
            steps.previous();
          }}
        />
      </div>
    </Section>
  );
}
