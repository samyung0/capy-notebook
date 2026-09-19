import { QueryClientContext } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useContext } from 'react';
import { useFlashcardSet, useQuiz } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Skeleton } from '@/components/ui/feedback';
import type { MaterialRefKind } from '@/features/materials/document';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { materialIconName } from '@/lib/fileIcons';

/** Compact card a note renders for an embedded quiz or flashcard set: kind
 * icon, title, counts and the study action. The content lives in the
 * referenced material; the note never inlines it. Static previews render the
 * same card without a query client, so the data-bound part is optional. */
export function MaterialRefCard({
  materialId,
  refKind,
  onEdit,
  className,
}: {
  materialId: string;
  refKind: MaterialRefKind;
  onEdit?: () => void;
  className?: string;
}) {
  const hasQueries = useContext(QueryClientContext) !== undefined;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-card border border-line bg-surface p-3',
        className
      )}
      contentEditable={false}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-card bg-surface-hover-bg">
        <FileIcon className="size-5" name={materialIconName(refKind)} />
      </span>
      {materialId && hasQueries ? (
        refKind === 'quiz' ? (
          <QuizRefBody materialId={materialId} onEdit={onEdit} />
        ) : (
          <FlashcardsRefBody materialId={materialId} onEdit={onEdit} />
        )
      ) : (
        <div className="min-w-0 flex-1">
          <p className="t-subtitle truncate">
            {refKind === 'quiz' ? m.editor_quiz() : m.editor_flashcards()}
          </p>
          <p className="t-meta text-fg-muted">
            {materialId
              ? m.material_ref_unavailable()
              : m.material_ref_pending()}
          </p>
        </div>
      )}
    </div>
  );
}

function RefBody({
  title,
  meta,
  action,
  onEdit,
}: {
  title: string;
  meta: string;
  action: React.ReactNode;
  onEdit?: () => void;
}) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <p className="t-subtitle truncate">{title}</p>
        <p className="t-meta text-fg-muted">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onEdit && (
          <Button onClick={onEdit} size="sm" variant="ghost">
            {m.action_edit()}
          </Button>
        )}
        {action}
      </div>
    </>
  );
}

function Unavailable({ refKind }: { refKind: MaterialRefKind }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="t-subtitle truncate">
        {refKind === 'quiz' ? m.editor_quiz() : m.editor_flashcards()}
      </p>
      <p className="t-meta text-fg-muted">{m.material_ref_unavailable()}</p>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <Skeleton className="h-4 w-2/5 rounded-button" />
      <Skeleton className="h-3 w-1/4 rounded-button" />
    </div>
  );
}

function QuizRefBody({
  materialId,
  onEdit,
}: {
  materialId: string;
  onEdit?: () => void;
}) {
  const { data, isPending, isError } = useQuiz(materialId, {
    errorBoundary: false,
  });
  if (isError) return <Unavailable refKind="quiz" />;
  if (isPending || !data) return <Loading />;
  const meta = [
    m.material_ref_questions({ count: data.questions.length }),
    data.timeLimitMin
      ? m.material_ref_minutes({ count: data.timeLimitMin })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <RefBody
      action={
        <Button asChild iconRight="arrowRight" size="sm" variant="outline">
          <Link params={{ quizId: materialId }} to="/quizzes/$quizId/attempt">
            {m.quiz_start()}
          </Link>
        </Button>
      }
      meta={meta}
      onEdit={onEdit}
      title={data.name}
    />
  );
}

function FlashcardsRefBody({
  materialId,
  onEdit,
}: {
  materialId: string;
  onEdit?: () => void;
}) {
  const { data, isPending, isError } = useFlashcardSet(materialId, {
    errorBoundary: false,
  });
  if (isError) return <Unavailable refKind="flashcards" />;
  if (isPending || !data) return <Loading />;
  const meta = [
    m.material_ref_cards({ count: data.cardCount }),
    m.material_ref_known({ pct: data.knownPct }),
    data.dueCount > 0 ? m.flashcards_due_count({ count: data.dueCount }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <RefBody
      action={
        <Button asChild iconRight="arrowRight" size="sm" variant="outline">
          <Link
            params={{ flashcardSetId: materialId }}
            to="/flashcards/$flashcardSetId"
          >
            {m.action_study()}
          </Link>
        </Button>
      }
      meta={meta}
      onEdit={onEdit}
      title={data.name}
    />
  );
}
