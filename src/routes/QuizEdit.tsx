import { zodResolver } from '@hookform/resolvers/zod';
import {
  linkOptions,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  UpdateQuizMetadataBody,
  updateQuizMetadataBodyNameMax,
} from '@/api/gen/validators';
import { useQuizEdit, useUpdateQuizMetadata } from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { TabContent, TabHeader } from '@/components/app/tabPanel';
import { SaveBanner } from '@/components/banners/SaveBanner';
import { Skeleton } from '@/components/ui/feedback';
import { Input, InputField } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
import {
  LiveStatus,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import { MaterialModeToggle } from '@/features/materials/MaterialModeToggle';
import {
  useQuizQuestions,
  useQuizRooms,
} from '@/features/quizzes/liveQuizRooms';
import { QuizForm, QuizRecovery } from '@/features/quizzes/QuizForm';
import {
  blockHomeCrumb,
  QuizPageHeader,
  QuizQuestionList,
} from '@/features/quizzes/QuizPage';
import { m } from '@/i18n';
import { textLength } from '@/lib/textLength';

const detailsSchema = z.object({
  name: UpdateQuizMetadataBody.shape.name.unwrap(),
});

export default function QuizEdit() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  return <QuizEditor key={quizId} quizId={quizId} />;
}

/** The live quiz editor (Epo 2026-10-10): questions edit the quiz's
 * documents as you type; there is no Save or Reset. The name saves on blur,
 * the cloud status follows the title as on notes, and the View switch leaves
 * editing. */
function QuizEditor({ quizId }: { quizId: string }) {
  const navigate = useNavigate();
  const { returnTo } = useSearch({ from: '/auth-shell/quizzes/$quizId/edit' });
  const {
    data: quiz,
    fetchStatus,
    isLoading,
    isFetchedAfterMount,
  } = useQuizEdit(quizId);
  const { mutate: updateMetadata } = useUpdateQuizMetadata();
  const rooms = useQuizRooms(quizId, { edit: true });
  const questions = useQuizQuestions(rooms.content?.doc, rooms.keys?.doc);

  const {
    control,
    register,
    reset,
    trigger,
    formState: { errors },
  } = useForm<z.infer<typeof detailsSchema>>({
    defaultValues: { name: '' },
    mode: 'onBlur',
    resolver: zodResolver(detailsSchema),
  });
  const name = useWatch({ control, name: 'name' });
  const [tab, setTab] = useState('questions');
  const seeded = useRef(false);
  // The name seeds once the quiz loads. A failed refresh seeds from the
  // cached quiz; without one the error went to the boundary.
  useEffect(() => {
    if (quiz && isFetchedAfterMount && !seeded.current) {
      reset({ name: quiz.name });
      seeded.current = true;
    }
  }, [quiz, isFetchedAfterMount, reset]);

  function back() {
    void navigate({ href: returnTo ?? '/files?tab=blocks' });
  }

  async function saveName() {
    if (!quiz || name === quiz.name || !(await trigger('name'))) return;
    updateMetadata({ id: quizId, name });
  }

  const editable = !!quiz?.canEditContent && rooms.access === 'write';
  return (
    <PanelWithInvertedRadius
      header={
        <QuizPageHeader
          actions={
            <div className="flex items-center gap-1">
              {rooms.undo && <UndoButtons manager={rooms.undo} />}
              <MaterialModeToggle mode="edit" onChange={back} />
            </div>
          }
          className="px-6 pt-6 pb-2 sm:px-6 sm:pt-6 lg:px-6 xl:px-6"
          onBack={back}
          title={
            <span className="flex items-center gap-2">
              {m.quiz_edit()}
              <LiveStatus compact status={rooms.status} />
            </span>
          }
          topBar={<TopInsetBar className="hidden shrink-0 lg:flex" />}
          trail={
            quiz
              ? [
                  blockHomeCrumb(quiz),
                  {
                    label: name || quiz.name,
                    link: linkOptions({
                      params: { quizId },
                      to: '/quizzes/$quizId/attempt',
                    }),
                  },
                ]
              : []
          }
        />
      }
    >
      <Tabs
        className="px-6"
        onChange={setTab}
        tabs={[
          { label: m.quiz_questions(), value: 'questions' },
          { label: m.settings_tab_general(), value: 'general' },
        ]}
        value={tab}
      />
      <TabContent>
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : rooms.status === 'unavailable' ? (
          <p role="alert">{m.quiz_unable_load()}</p>
        ) : isLoading || !seeded.current ? (
          <Skeleton className="h-64 w-full" />
        ) : quiz?.canEditContent && rooms.access !== 'read' ? (
          <>
            {tab === 'general' ? (
              <>
                <TabHeader
                  description={m.quiz_details_hint()}
                  title={m.settings_tab_general()}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <InputField
                    count={{
                      max: updateQuizMetadataBodyNameMax,
                      value: textLength(name),
                    }}
                    error={errors.name}
                    id="quiz-name"
                    label={m.quiz_name()}
                  >
                    <Input
                      id="quiz-name"
                      {...register('name', { onBlur: () => void saveName() })}
                    />
                  </InputField>
                </div>
              </>
            ) : (
              <>
                <h2 className="t-card-title mb-7">{m.quiz_questions()}</h2>
                {rooms.recovery ? (
                  <QuizRecovery recovery={rooms.recovery} rooms={rooms} />
                ) : rooms.ready && rooms.content && rooms.keys && editable ? (
                  <div className="grid gap-6">
                    {rooms.offline && <SaveBanner state={rooms.offline} />}
                    {rooms.offline === 'offline-limit' ? (
                      <QuizQuestionList
                        disabled
                        questions={questions}
                        showAnswerKey
                      />
                    ) : (
                      <QuizForm
                        content={rooms.content.doc}
                        keys={rooms.keys.doc}
                        name={name}
                        questions={questions}
                        quizId={quizId}
                        status={rooms.status}
                        undo={rooms.undo}
                      />
                    )}
                  </div>
                ) : (
                  <Skeleton className="h-64 w-full" />
                )}
              </>
            )}
            <SourcesLine className="mt-16 pb-4" provenance={quiz.provenance} />
          </>
        ) : (
          <p className="py-8 text-center text-fg-muted">{m.quiz_not_found()}</p>
        )}
      </TabContent>
    </PanelWithInvertedRadius>
  );
}
