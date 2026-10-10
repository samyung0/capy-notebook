import { useEffect, useRef, useState } from 'react';
import {
  useMaterial,
  useQuiz,
  useQuizEdit,
  useSubmitAttempt,
  useUpdateQuizContent,
} from '@/api/hooks';
import type { Material, Question } from '@/api/types';
import { FlashcardsEditor } from '@/features/flashcards/FlashcardsEditor';
import { StudyBody } from '@/features/flashcards/StudyBody';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
} from '@/features/materials/document';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { QuizForm } from '@/features/quizzes/QuizForm';
import { usePickedImages } from '@/features/quizzes/usePickedImages';
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
          <QuizEditor onEmpty={onEmpty} quizId={materialId} />
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

/** The quiz editor's question list, each change saved at once with the
 * revision the last save returned; removing the last question removes the
 * block instead. */
function QuizEditor({
  quizId,
  onEmpty,
}: {
  quizId: string;
  onEmpty: () => void;
}) {
  const { data: quiz } = useQuizEdit(quizId);
  const { mutateAsync: updateContent } = useUpdateQuizContent();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const revision = useRef<number | null>(null);
  const saving = useRef(Promise.resolve());
  const { pick, previewUrl, uploadPicked } = usePickedImages(
    quizId,
    setQuestions
  );
  useEffect(() => {
    if (!quiz || revision.current !== null) return;
    setQuestions(structuredClone(quiz.questions));
    revision.current = quiz.revision;
  }, [quiz]);

  async function persist(next: Question[]) {
    if (revision.current === null) return;
    try {
      const saved = await updateContent({
        expectedRevision: revision.current,
        id: quizId,
        questions: await uploadPicked(next),
      });
      revision.current = saved.revision;
    } catch {
      // The global mutation handler shows the normalized failure.
    }
  }
  function change(next: Question[]) {
    if (next.length === 0) return onEmpty();
    setQuestions(next);
    // One save at a time, each with the revision the previous one returned.
    saving.current = saving.current.then(() => persist(next));
  }

  if (!questions) return <EmbedLoading />;
  return (
    <AssetUrlContext.Provider value={previewUrl}>
      <QuizForm
        name=""
        onQuestionsChange={change}
        questions={questions}
        uploadAsset={pick}
      />
    </AssetUrlContext.Provider>
  );
}
