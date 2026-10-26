import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { invalidateStudy, useRateReviewItem } from '@/api/hooks';
import type { ReviewItem, UnfinishedSession } from '@/api/types';
import { CardSlider } from '@/components/app/CardSlider';
import { Button } from '@/components/ui/Button';
import { userToast } from '@/components/ui/userToast';
import { CardImage } from '@/features/flashcards/CardView';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { TextView } from '@/features/questions/TextView';
import {
  GAP_MARKER,
  type LearnerQuestion,
  type Question,
  type QuestionBlock,
} from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { CheckedQuestion, QuestionItem } from '@/features/study/ReviewQuestion';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { PREF_KEYS, readPref, writePref } from '@/lib/localPrefs';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { RatingTiles } from './RatingTiles';
import { ZoomCard, type ZoomCardHandle } from './ZoomCard';

/* The Study page's quick actions (human/study-progress.md 2026-10-18/19):
 * the whole workspace's review and Quick review. */

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
      <div className="flex items-baseline justify-between gap-3 pb-1.5">
        <h3 className="font-bold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The whole workspace's (or with `planId` the whole plan's) review as one
 * row: Continue picks up its latest unfinished session (its progress under
 * the title), otherwise Start begins a new one. Either way the session is
 * recorded with its first answer. */
export function WorkspaceReview({
  workspaceId,
  planId,
  iconId,
  unfinished,
}: {
  workspaceId: string;
  planId?: string;
  iconId?: string;
  unfinished?: UnfinishedSession;
}) {
  // Always opens the review page, which says when there is nothing to review.
  const content = (
    <span className="flex w-full items-start gap-2.5 border-divider border-t px-1.5 py-2.5 group-hover:bg-surface-hover-bg">
      {iconId ? (
        <img
          alt=""
          className="mt-0.5 size-5 shrink-0 rounded-[4px]"
          height={20}
          src={iconUrl(iconId)}
          width={20}
        />
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 translate-y-px flex-col gap-1">
        <span className="line-clamp-1 font-semibold">
          {planId
            ? unfinished
              ? m.study_continue_plan_review()
              : m.study_start_plan_review()
            : unfinished
              ? m.study_continue_workspace_review()
              : m.study_start_workspace_review()}
        </span>
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
    </span>
  );
  return (
    <Link
      className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
      params={{ workspaceId }}
      search={
        unfinished
          ? { from: 'workspace', session: unfinished.id }
          : planId
            ? { from: 'workspace', group: 'plan', planId }
            : { from: 'workspace', group: 'workspace' }
      }
      to="/learning/review/$workspaceId"
    >
      {content}
    </Link>
  );
}

type QuickPhase = 'open' | 'leaving' | 'gone';

const keyOf = (it: ReviewItem) => `${it.materialId}/${it.itemId}`;

/** How long one Quick review batch lasts (Epo, 2026-10-25). */
const BATCH_MS = 4 * 60 * 60 * 1000;

/** A batch as this browser keeps it per workspace: the items as served when
 * it began, and the keys answered (a rating or Check sent). */
type QuickBatch = { startedAt: number; items: ReviewItem[]; done: string[] };

const isBatch = (value: unknown): value is QuickBatch =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as QuickBatch).startedAt === 'number' &&
  Array.isArray((value as QuickBatch).items) &&
  Array.isArray((value as QuickBatch).done);

/** The stored batch while it lasts, else a new one from the served items
 * (none while there is nothing to practise); QuickReview stores it. `scope`
 * is the workspace, or `plan-<id>` for a plan's batch. */
export function currentBatch(scope: string, items: ReviewItem[]) {
  const key = PREF_KEYS.quickReview(scope);
  const stored = readPref<QuickBatch | null>(key, null, isBatch);
  if (stored && Date.now() - stored.startedAt < BATCH_MS) return stored;
  if (items.length === 0) return null;
  return { done: [], items, startedAt: Date.now() } satisfies QuickBatch;
}

/** The Study page's short practice: up to four flashcards and single-part
 * quick questions, picked by the server as a suggested review would, as a
 * row of small cards (human/study-progress.md 2026-10-25). A card zooms into
 * a centred dialog; once answered the next card takes its place there, and
 * answered cards leave the row. Ratings and checks are recorded like any
 * review. A batch lasts four hours in this browser, its answered items
 * remembered, so reopening the workspace neither repeats nor reshuffles it;
 * once its last item is done the section dissolves into smoke and stays gone
 * until the batch runs out. */
export function QuickReview({
  items,
  workspaceId,
  planId,
}: {
  items: ReviewItem[];
  workspaceId: string;
  /** A plan's Quick review, batched apart from the workspace's. */
  planId?: string;
}) {
  const scope = planId ? `plan-${planId}` : workspaceId;
  const [batch, setBatch] = useState(() => currentBatch(scope, items));
  const [openKey, setOpenKey] = useState<string>();
  const [checked, setChecked] = useState<CheckedRecord>();
  const [phase, setPhase] = useState<QuickPhase>('open');
  const slots = useRef(new Map<string, HTMLButtonElement>());
  const zoom = useRef<ZoomCardHandle>(null);
  // Answered keys as sent, ahead of the render: one rating or check each.
  const sent = useRef(new Set(batch?.done));
  // Items moved past in the dialog; from the first, each one slides in.
  const [turns, setTurns] = useState(0);
  const qc = useQueryClient();
  // A plan's items live in several workspaces: an answer refreshes them all.
  const refreshed = planId ? undefined : workspaceId;
  const { mutateAsync: rateItem } = useRateReviewItem(refreshed);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // The batch and its answers outlive the page for its four hours: a new
  // batch, and each answer as it is sent.
  useEffect(() => {
    if (batch) writePref(PREF_KEYS.quickReview(scope), batch);
  }, [batch, scope]);
  // A batch can only start once there is something to practise.
  if (!batch && items.length > 0) setBatch(currentBatch(scope, items));
  if (!batch || phase === 'gone') return null;
  const round = batch.items;
  const done = new Set(batch.done);
  const allDone = round.every((it) => done.has(keyOf(it)));
  // A batch finished earlier stays gone; one finished here dissolves.
  if (allDone && phase === 'open' && !openKey) return null;
  // The open item keeps its slot until the card closes back into it.
  const left = round.filter(
    (it) => !done.has(keyOf(it)) || keyOf(it) === openKey
  );
  const item = openKey ? round.find((it) => keyOf(it) === openKey) : undefined;
  const leaving = phase === 'leaving';

  function settle(key: string) {
    if (!batch || sent.current.has(key)) return;
    sent.current.add(key);
    setBatch({ ...batch, done: [...batch.done, key] });
  }

  /** The next unanswered card after the open one takes its place; after the
   * last, the card closes back into its slot. */
  function advance() {
    if (!item) return;
    const rest = left.filter((it) => it !== item);
    const next = rest[left.indexOf(item) % Math.max(rest.length, 1)];
    if (!next) {
      zoom.current?.close();
      return;
    }
    setTurns((n) => n + 1);
    setChecked(undefined);
    setOpenKey(keyOf(next));
  }

  function rate(rating: SrsRating) {
    if (!item || sent.current.has(keyOf(item))) return;
    settle(keyOf(item));
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
    advance();
  }

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
        <Section title={m.study_quick_review()}>
          <CardSlider className="gap-3">
            {left.map((it) => {
              const key = keyOf(it);
              return (
                <div className="w-44 shrink-0 sm:w-50" key={key}>
                  <button
                    className={cn(
                      'flex h-29.5 w-full flex-col justify-between gap-2 rounded-tile border border-line bg-surface frosted:bg-(--frost-fill) p-3 text-left transition-[border-color] duration-(--motion-duration-quick) hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
                      // The card is out of its slot while zoomed.
                      key === openKey && 'invisible'
                    )}
                    onClick={() => setOpenKey(key)}
                    ref={(node) => {
                      if (node) slots.current.set(key, node);
                      else slots.current.delete(key);
                    }}
                    type="button"
                  >
                    <QuickFace item={it} />
                  </button>
                </div>
              );
            })}
          </CardSlider>
        </Section>
      </div>
      {item && (
        <ZoomCard
          aside={
            <span className="t-meta shrink-0 text-fg-muted">
              {m.study_quick_position({
                current:
                  round.filter(
                    (it) => done.has(keyOf(it)) && keyOf(it) !== openKey
                  ).length + 1,
                total: round.length,
              })}
            </span>
          }
          face={<QuickFace item={item} />}
          onClosed={() => {
            setChecked(undefined);
            setOpenKey(undefined);
            setTurns(0);
            // Reduced motion runs no animation, so there is no end to wait for.
            if (round.every((it) => sent.current.has(keyOf(it))))
              setPhase(reduceMotion ? 'gone' : 'leaving');
          }}
          ref={zoom}
          returnFocus={() =>
            [...slots.current.values()].find((slot) => slot.isConnected)
          }
          source={() => slots.current.get(keyOf(item))}
          title={item.materialTitle}
        >
          <div
            className={cn(
              'flex flex-col gap-3.5',
              turns > 0 && 'motion-safe:motion-quick-swap-in'
            )}
            key={keyOf(item)}
          >
            {item.kind === 'card' ? (
              <QuickFlashcard item={item} onRate={rate} />
            ) : checked ? (
              <>
                <CheckedQuestion
                  answers={checked.answers}
                  headerMarks={false}
                  question={checked.question}
                />
                <div className="flex justify-end">
                  <Button
                    className="h-9 px-3.5"
                    onClick={advance}
                    rounded="normal"
                    size="sm"
                  >
                    {left.length > 1 ? m.action_next() : m.question_ui_done()}
                  </Button>
                </div>
              </>
            ) : (
              <QuestionItem
                headerMarks={false}
                item={item}
                onCheck={() => settle(keyOf(item))}
                onChecked={(graded, answers) => {
                  void invalidateStudy(qc, refreshed);
                  setChecked({ answers, question: graded.question });
                }}
                source={false}
              />
            )}
          </div>
        </ZoomCard>
      )}
    </div>
  );
}

/** The dialog's flashcard (the 2026-10-25 mock): a grey face that turns
 * over in 3D on a click, its ratings rising in under it once the back
 * shows. Their room is kept from the start so the card never grows. */
function QuickFlashcard({
  item,
  onRate,
}: {
  item: ReviewItem;
  onRate: (rating: SrsRating) => void;
}) {
  const [flipped, setFlipped] = useState(false);
  // Chosen once: every tile is disabled until the card moves on or closes.
  const [rated, setRated] = useState<SrsRating>();
  return (
    <>
      <div className="perspective-[1200px]">
        {/* Named by the face showing; the other is inert, so unread. */}
        <button
          className={cn(
            'transform-3d relative block h-55 w-full rounded-[14px] transition-transform duration-[520ms] ease-(--motion-ease-smooth-out) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action motion-reduce:transition-none sm:h-50',
            flipped && 'rotate-y-180'
          )}
          onClick={() => setFlipped((f) => !f)}
          type="button"
        >
          <FlipFace inert={flipped}>
            <span className="whitespace-pre-line text-balance break-words font-bold text-[1.3125rem] leading-snug">
              {item.front}
            </span>
            {item.image && (
              <CardImage assetId={item.image.assetId} className="h-20" />
            )}
            <span className="t-meta text-fg-muted">
              {m.flashcards_click_to_flip()}
            </span>
          </FlipFace>
          <FlipFace back inert={!flipped}>
            <span className="whitespace-pre-line text-pretty break-words font-semibold text-[1.0625rem] leading-relaxed">
              {item.back}
            </span>
          </FlipFace>
        </button>
      </div>
      {flipped ? (
        <RatingTiles
          chosen={rated}
          onRate={(rating) => {
            setRated(rating);
            onRate(rating);
          }}
        />
      ) : (
        <div aria-hidden className="invisible" inert>
          <RatingTiles onRate={() => undefined} />
        </div>
      )}
    </>
  );
}

/** One side of the dialog's flashcard, hidden while turned away. */
function FlipFace({
  back = false,
  inert,
  children,
}: {
  back?: boolean;
  inert: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'justify-center-safe backface-hidden absolute inset-0 flex flex-col items-center gap-3 overflow-y-auto rounded-[14px] bg-surface-dark/60 px-4 py-3 text-center',
        back && 'rotate-y-180'
      )}
      inert={inert}
    >
      {children}
    </span>
  );
}

/** A checked question with its key, shown until Next. */
type CheckedRecord = { answers: Answers; question: Question };

/** A small card's face: the front or the question's prompt, then where it
 * comes from. Also drawn at the slot's size while the card zooms. */
function QuickFace({ item }: { item: ReviewItem }) {
  return (
    <>
      <span className="line-clamp-3 font-semibold text-sm">
        {item.kind === 'card' ? (
          item.front
        ) : (
          <TextView text={item.question ? promptOf(item.question) : ''} />
        )}
      </span>
      <span className="truncate font-semibold text-fg-muted text-xs">
        {item.materialTitle} ·{' '}
        {item.kind === 'card'
          ? m.progress_one_card()
          : m.question_ui_one_question()}
      </span>
    </>
  );
}

/** A question's prompt: its first part's text, else the stem's, with blanks
 * drawn as a rule. */
function promptOf(question: LearnerQuestion) {
  const text = (blocks: QuestionBlock[]) =>
    blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join(' ');
  return (text(question.parts[0]?.blocks ?? []) || text(question.stem)).replace(
    GAP_MARKER,
    '____'
  );
}
