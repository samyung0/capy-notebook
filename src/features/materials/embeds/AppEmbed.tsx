import { useMaterial, useQuiz, useSubmitAttempt } from '@/api/hooks';
import type { Material } from '@/api/types';
import { FlashcardsEditor } from '@/features/flashcards/FlashcardsEditor';
import { StudyBody } from '@/features/flashcards/StudyBody';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
} from '@/features/materials/document';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { QuizEditor } from '@/features/quizzes/QuizEditor';
import { EmbedLoading, type EmbedProps, EmbedUnavailable } from './EmbedView';

/* A note's embedded quiz or flashcard set inside the app, read through the
   account. View studies it in place (a quick check: nothing is recorded);
   Edit edits it in place, each change saved at once. */

type OwnedProps = EmbedProps & {
  /** In an editing note: the block waits as a skeleton until its item is the
   * note's own (a pasted block until the collaboration service repoints it
   * to a copy, a restored one until the query reloads). */
  ownerId?: string;
};

const waitingForOwn = (
  ownerId: string | undefined,
  isError: boolean,
  data: { parentMaterialId?: string } | undefined
) => !!ownerId && (isError || (!!data && data.parentMaterialId !== ownerId));

const setCards = (material: Material) =>
  flashcardsElementToCards(
    material.content.value.find(
      (node): node is FlashcardsElement => node.type === 'flashcards'
    ) ?? { children: [], id: '', type: 'flashcards' }
  );

export function AppEmbedView({ materialId, refKind, ownerId }: OwnedProps) {
  return refKind === 'quiz' ? (
    <QuizView materialId={materialId} ownerId={ownerId} />
  ) : (
    <SetGate materialId={materialId} ownerId={ownerId}>
      {(material) => (
        <StudyBody
          cards={setCards(material)}
          embedded
          name=""
          onRate={() => undefined}
          provenance={material.provenance}
          trail={[]}
        />
      )}
    </SetGate>
  );
}

export function AppEmbedEdit({
  materialId,
  refKind,
  ownerId,
  onEmpty,
}: OwnedProps & {
  /** Removing the last question or card removes the block instead. */
  onEmpty: () => void;
}) {
  return refKind === 'quiz' ? (
    <QuizGate materialId={materialId} ownerId={ownerId}>
      {(quiz) => (
        <>
          <QuizEditor
            onEmpty={onEmpty}
            quizId={materialId}
            saveEachChange
            title=""
          />
          <SourcesLine className="mt-3" provenance={quiz.provenance} />
        </>
      )}
    </QuizGate>
  ) : (
    <SetGate materialId={materialId} ownerId={ownerId}>
      {(material) => (
        <>
          <FlashcardsEditor
            cards={setCards(material)}
            onEmpty={onEmpty}
            revision={material.revision}
            saveEachChange
            setId={materialId}
            showTitle={false}
            title=""
          />
          <SourcesLine className="mt-3" provenance={material.provenance} />
        </>
      )}
    </SetGate>
  );
}

function QuizGate({
  materialId,
  ownerId,
  children,
}: {
  materialId: string;
  ownerId?: string;
  children: (
    quiz: NonNullable<ReturnType<typeof useQuiz>['data']>
  ) => React.ReactNode;
}) {
  const { data, isPending, isError } = useQuiz(materialId, {
    errorBoundary: false,
  });
  if (waitingForOwn(ownerId, isError, data)) return <EmbedLoading />;
  if (isError) return <EmbedUnavailable />;
  if (isPending || !data) return <EmbedLoading />;
  return <>{children(data)}</>;
}

function SetGate({
  materialId,
  ownerId,
  children,
}: {
  materialId: string;
  ownerId?: string;
  children: (material: Material) => React.ReactNode;
}) {
  const { data, isPending, isError } = useMaterial(materialId, {
    errorBoundary: false,
  });
  if (waitingForOwn(ownerId, isError, data)) return <EmbedLoading />;
  if (isError) return <EmbedUnavailable />;
  if (isPending || !data) return <EmbedLoading />;
  return <>{children(data)}</>;
}

function QuizView({
  materialId,
  ownerId,
}: {
  materialId: string;
  ownerId?: string;
}) {
  const { mutateAsync: submit } = useSubmitAttempt({ errorToast: false });
  return (
    <QuizGate materialId={materialId} ownerId={ownerId}>
      {(quiz) => (
        <AttemptBody
          embedded
          grade={async (answers) => {
            const attempt = await submit({ answers, quizId: materialId });
            return {
              awarded: attempt.correct,
              max: attempt.total,
              questions: attempt.questions,
            };
          }}
          name=""
          provenance={quiz.provenance}
          questions={quiz.questions}
          trail={[]}
        />
      )}
    </QuizGate>
  );
}
