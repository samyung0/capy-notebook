import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import {
  useChapters,
  useFiles,
  useMaterials,
  useRateReviewItem,
  useSetWorkspaceStudyEnabled,
  useWorkspaceStudy,
} from '@/api/hooks';
import type { ReviewItem } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { userToast } from '@/components/ui/userToast';
import type { OpenItem } from '@/features/materials/openItem';
import type { TabAction } from '@/features/workspace/PanelTabRow';
import {
  readingOrder,
  type WorkspaceContentItem,
} from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { RATING_LABEL, RATING_STYLE } from './ratings';

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
  const { data: study } = useWorkspaceStudy(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { mutate: setEnabled } = useSetWorkspaceStudyEnabled(workspaceId);

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
                    <div className="flex flex-col gap-2 px-2">
                      {next && (
                        <div className="flex items-center gap-2">
                          <ItemIcon item={next} />
                          <span className="line-clamp-1 flex-1 translate-y-px">
                            {itemTitle(next)}
                          </span>
                          <Button
                            iconRight="arrowRight"
                            onClick={() =>
                              onOpenItem({ id: next.id, kind: next.type })
                            }
                            size="sm"
                          >
                            {m.study_continue()}
                          </Button>
                        </div>
                      )}
                      {study.reviewable > 0 && (
                        <div className="flex items-center gap-2">
                          <Icon
                            className="shrink-0 text-fg-muted"
                            name="refresh"
                            size={15}
                          />
                          <span className="flex-1 translate-y-px">
                            {m.study_refresh_knowledge()}
                          </span>
                          <ReviewButton workspaceId={workspaceId} />
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

/** Opens this workspace's review session; Back returns to the workspace. */
export function ReviewButton({
  workspaceId,
  variant = 'outline',
}: {
  workspaceId: string;
  variant?: 'outline' | 'dark';
}) {
  const navigate = useNavigate();
  return (
    <Button
      onClick={() =>
        navigate({
          params: { workspaceId },
          search: { from: 'workspace' },
          to: '/learning/review/$workspaceId',
        })
      }
      size="sm"
      variant={variant}
    >
      {m.study_review_button()}
    </Button>
  );
}

/** One missed flashcard at a time; a rating is recorded like any review
 * rating, so a card rated Good drops down the list on the next refresh. */
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
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const { mutateAsync: rateItem } = useRateReviewItem(workspaceId);
  const card = round[index];
  if (!card) return null;

  function rate(rating: SrsRating) {
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
    setFlipped(false);
    if (index + 1 < round.length) setIndex(index + 1);
    else {
      setRound(items);
      setIndex(0);
    }
  }

  return (
    <Section
      aside={
        <span className="t-meta px-1.5 text-fg-muted">
          {m.study_quick_position({ current: index + 1, total: round.length })}
        </span>
      }
      title={m.study_quick_review()}
    >
      <div className="flex flex-col gap-2 px-1.5 pt-1">
        <button
          aria-label={flipped ? card.back : m.flashcards_show_answer()}
          className="flex h-36 flex-col items-center justify-center rounded-card border border-line bg-surface px-4 text-center"
          onClick={() => setFlipped((f) => !f)}
          type="button"
        >
          <p className="t-label text-fg-muted">{card.front}</p>
          {flipped && <p className="mt-2 font-semibold">{card.back}</p>}
          <p className="t-meta mt-3 text-fg-muted">{card.materialTitle}</p>
        </button>
        {flipped && (
          <div className="grid grid-cols-4 gap-1.5">
            {SRS_RATINGS.map((r) => (
              <button
                className={cn(
                  'rounded-button border px-2 py-1.5 font-semibold text-xs transition-colors',
                  RATING_STYLE[r]
                )}
                key={r}
                onClick={() => rate(r)}
                type="button"
              >
                {RATING_LABEL[r]()}
              </button>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}
