import { useContext, useEffect, useRef, useState } from 'react';
import { useMaterial, useQuiz, useSubmitAttempt } from '@/api/hooks';
import type { Material } from '@/api/types';
import { FileBanner } from '@/components/banners/FileBanner';
import { isOutdatedBanner, SaveBanner } from '@/components/banners/SaveBanner';
import { itemEditingStopped } from '@/features/collaboration/itemRoom';
import { NoteSeatContext } from '@/features/collaboration/noteSeat';
import { SlowedOpenLine } from '@/features/collaboration/SlowedOpen';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { LiveFlashcards } from '@/features/flashcards/LiveFlashcards';
import { useLiveSetCards } from '@/features/flashcards/liveReads';
import { StudyBody } from '@/features/flashcards/StudyBody';
import {
  type FlashcardsElement,
  flashcardsElementToCards,
} from '@/features/materials/document';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import {
  useQuizQuestions,
  useQuizRooms,
} from '@/features/quizzes/liveQuizRooms';
import { QuizForm, QuizRecovery } from '@/features/quizzes/QuizForm';
import { QuizQuestionList } from '@/features/quizzes/QuizPage';
import { m } from '@/i18n';
import { EmbedLoading, type EmbedProps, EmbedUnavailable } from './EmbedView';

/* A note's embedded quiz or flashcard set inside the app, read through the
   account. View studies it in place (a quick check: nothing is recorded) and
   follows the item's live room. Edit edits it in place through its live
   rooms, joined while the block is near the screen (live-items). */

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

/** A reference names one of the embed catalog's item kinds; another fails
 * loudly instead of drawing as some other kind (AppEmbed.test.tsx). */
function unknownKind(refKind: never): never {
  throw new Error(`No embed for the material kind ${String(refKind)}`);
}

export function AppEmbedView({ materialId, refKind, ownerId }: OwnedProps) {
  switch (refKind) {
    case 'quiz':
      return <QuizView materialId={materialId} ownerId={ownerId} />;
    case 'flashcards':
      return (
        <SetGate materialId={materialId} ownerId={ownerId}>
          {(material) => <LiveSetStudy material={material} />}
        </SetGate>
      );
    default:
      return unknownKind(refKind);
  }
}

/** A set in a note's View: its room joins while the block is near the
 * screen, as in Edit (REVIEW5 S5). */
function LiveSetStudy({ material }: { material: Material }) {
  const box = useRef<HTMLDivElement>(null);
  const { near, entered } = useNearScreen(box);
  const inside = useContext(NoteSeatContext);
  const cards = useLiveSetCards(material.id, setCards(material), near, {
    inside,
    wake: entered,
  });
  return (
    <div ref={box}>
      <StudyBody
        cards={cards}
        embedded
        name=""
        onRate={() => undefined}
        provenance={material.provenance}
        trail={[]}
      />
    </div>
  );
}

function LiveSetEdit({
  materialId,
  onEmpty,
}: {
  materialId: string;
  onEmpty: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { near, entered } = useNearScreen(box);
  const inside = useContext(NoteSeatContext);
  return (
    <div ref={box}>
      <LiveFlashcards
        enabled={near}
        inside={inside}
        onEmpty={onEmpty}
        setId={materialId}
        showTitle={false}
        showUndo={false}
        title=""
        wake={entered}
      />
    </div>
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
  switch (refKind) {
    case 'quiz':
      return (
        <QuizGate materialId={materialId} ownerId={ownerId}>
          {(quiz) => (
            <>
              <EmbedQuizEditor onEmpty={onEmpty} quizId={materialId} />
              <SourcesLine className="mt-3" provenance={quiz.provenance} />
            </>
          )}
        </QuizGate>
      );
    case 'flashcards':
      return (
        <SetGate materialId={materialId} ownerId={ownerId}>
          {(material) => (
            <>
              <LiveSetEdit materialId={materialId} onEmpty={onEmpty} />
              <SourcesLine className="mt-3" provenance={material.provenance} />
            </>
          )}
        </SetGate>
      );
    default:
      return unknownKind(refKind);
  }
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
        <LiveQuizStudy
          grade={async (answers) => {
            const attempt = await submit({ answers, quizId: materialId });
            return {
              awarded: attempt.correct,
              max: attempt.total,
              questions: attempt.questions,
            };
          }}
          quiz={quiz}
        />
      )}
    </QuizGate>
  );
}

/** A quiz in a note's View: its content room joins while the block is near
 * the screen, as in Edit (REVIEW5 S5). */
function LiveQuizStudy({
  quiz,
  grade,
}: {
  quiz: NonNullable<ReturnType<typeof useQuiz>['data']>;
  grade: Parameters<typeof AttemptBody>[0]['grade'];
}) {
  const box = useRef<HTMLDivElement>(null);
  const { near, entered } = useNearScreen(box);
  const inside = useContext(NoteSeatContext);
  const questions = useLiveQuizQuestions(quiz.id, quiz.questions, near, {
    inside,
    wake: entered,
  });
  return (
    <div ref={box}>
      <AttemptBody
        embedded
        grade={grade}
        name=""
        provenance={quiz.provenance}
        questions={questions}
        trail={[]}
      />
    </div>
  );
}

/** A note's quiz in Edit: its live rooms while the block is near the screen
 * (and while edits wait for the server); removing the last question removes
 * the block. Undo and Redo are in the question dialog. */
function EmbedQuizEditor({
  quizId,
  onEmpty,
}: {
  quizId: string;
  onEmpty: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { near, entered } = useNearScreen(box);
  const inside = useContext(NoteSeatContext);
  const [held, setHeld] = useState(false);
  const rooms = useQuizRooms(quizId, {
    edit: true,
    enabled: near || held,
    inside,
    wake: entered,
  });
  useEffect(() => {
    setHeld(rooms.status === 'syncing' || rooms.status === 'offline');
  }, [rooms.status]);
  const questions = useQuizQuestions(rooms.content?.doc, rooms.keys?.doc);
  return (
    <div ref={box}>
      {rooms.status === 'unavailable' ? (
        <EmbedUnavailable />
      ) : rooms.recovery ? (
        <QuizRecovery recovery={rooms.recovery} rooms={rooms} />
      ) : rooms.ready && rooms.access === 'read' ? (
        // A room read-only for this writer (a block this version cannot
        // edit, a frozen account) shows the questions to read.
        <div className="grid gap-4">
          {rooms.readOnlyCode === 'unsupported_block' && (
            <FileBanner message={m.editor_unsupported_block_strip()} />
          )}
          <QuizQuestionList disabled questions={questions} />
        </div>
      ) : rooms.ready && rooms.content && rooms.keys ? (
        <div className="grid gap-4">
          {rooms.offline && <SaveBanner state={rooms.offline} />}
          {itemEditingStopped(rooms.offline) ? (
            <QuizQuestionList disabled questions={questions} showAnswerKey />
          ) : (
            <QuizForm
              content={rooms.content.doc}
              keys={rooms.keys.doc}
              name=""
              onEmpty={onEmpty}
              questions={questions}
              quizId={quizId}
              status={rooms.status}
              undo={rooms.undo}
            />
          )}
        </div>
      ) : isOutdatedBanner(rooms.offline) ? (
        // Refused as outdated before it synced: nothing of the rooms to show.
        <SaveBanner state="outdated" />
      ) : (
        <div className="flex flex-col gap-2">
          <EmbedLoading />
          <SlowedOpenLine slowed={rooms.slowed} />
        </div>
      )}
    </div>
  );
}
