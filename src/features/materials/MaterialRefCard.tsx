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
 * same card without a query client, so the data-bound part is optional.
 *
 * In an editing note (`ownerId`) a block waits as a skeleton until its
 * material is the note's own: another note's (pasted) until the collaboration
 * service repoints it to a copy, a trashed one (undo, cut and paste) until the
 * service restores it and the query reloads. */
export function MaterialRefCard({
  materialId,
  refKind,
  onEdit,
  ownerId,
  className,
}: {
  materialId: string;
  refKind: MaterialRefKind;
  onEdit?: () => void;
  ownerId?: string;
  className?: string;
}) {
  const hasQueries = useContext(QueryClientContext) !== undefined;
  return (
    <div
      className={cn('flex min-w-0 items-center gap-3 py-1.5', className)}
      contentEditable={false}
    >
      <FileIcon className="size-6 shrink-0" name={materialIconName(refKind)} />
      {materialId && hasQueries ? (
        refKind === 'quiz' ? (
          <QuizRefBody
            materialId={materialId}
            onEdit={onEdit}
            ownerId={ownerId}
          />
        ) : (
          <FlashcardsRefBody
            materialId={materialId}
            onEdit={onEdit}
            ownerId={ownerId}
          />
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
      {/* Edit mode offers only Edit; view mode starts or studies the set. */}
      <div className="shrink-0">
        {onEdit ? (
          <Button
            iconLeft="pencil"
            onClick={onEdit}
            size="sm"
            variant="outline"
          >
            {m.action_edit()}
          </Button>
        ) : (
          action
        )}
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

/** Waiting for the note's own material (see MaterialRefCard). */
const waitingForOwn = (
  ownerId: string | undefined,
  isError: boolean,
  data: { parentMaterialId?: string } | undefined
) => !!ownerId && (isError || (!!data && data.parentMaterialId !== ownerId));

function QuizRefBody({
  materialId,
  onEdit,
  ownerId,
}: {
  materialId: string;
  onEdit?: () => void;
  ownerId?: string;
}) {
  const { data, isPending, isError } = useQuiz(materialId, {
    errorBoundary: false,
  });
  if (waitingForOwn(ownerId, isError, data)) return <Loading />;
  if (isError) return <Unavailable refKind="quiz" />;
  if (isPending || !data) return <Loading />;
  const meta = m.material_ref_questions({ count: data.questions.length });
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
  ownerId,
}: {
  materialId: string;
  onEdit?: () => void;
  ownerId?: string;
}) {
  const { data, isPending, isError } = useFlashcardSet(materialId, {
    errorBoundary: false,
  });
  if (waitingForOwn(ownerId, isError, data)) return <Loading />;
  if (isError) return <Unavailable refKind="flashcards" />;
  if (isPending || !data) return <Loading />;
  const meta = m.material_ref_cards({ count: data.cardCount });
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
