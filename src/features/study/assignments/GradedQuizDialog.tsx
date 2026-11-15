import { useEffect, useRef, useState } from 'react';
import { useDeleteMaterial, useWorkspace } from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import type { MakeQuizChoice } from '@/features/makeQuiz/MakeQuizDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { AddPracticeDialog } from '../practice/AddPractice';
import { NewAssignmentDialog } from './NewAssignmentDialog';

const NO_FILES: MakeQuizChoice = { answers: [], paper: [] };

/** New graded quiz (Epo 2026-11-14, boards Graded quiz 1 Questions and 2
 * Settings): Add quiz's ways of getting questions make the graded quiz's own
 * quiz, hidden from members and waiting for it (`gradedQuiz`), then Continue
 * goes to today's marked-assignment settings. Creating the assignment makes
 * the quiz its own (the server's `materials.assignment_id`); a quiz made here
 * and left behind (Cancel, questions made again, or one that arrives after the
 * dialog closed) goes to the trash, and the server trashes one no graded quiz
 * took within a day (a Convert run finishing after a reload). Convert's pages
 * and run stay in the dialog, in its own state rather than the address. */
export function GradedQuizDialog({
  onClose,
  onDone,
  own,
  presetAssignee,
  presetTopicId,
  workspaceId,
}: {
  onClose: () => void;
  onDone: (assignment: Assignment) => void;
  /** A personal workspace's: a task for oneself. */
  own?: boolean;
  /** Opened from a member's profile (Q721): them as the only assignee. */
  presetAssignee?: string;
  /** The topic Generate quiz starts on: the profile card's (Q721). */
  presetTopicId?: string;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId, { errorBoundary: false });
  const { mutate: trash } = useDeleteMaterial(workspaceId);
  const [quizId, setQuizId] = useState<string>();
  const [step, setStep] = useState<'questions' | 'settings'>('questions');
  // Convert's own steps, as the address holds them for Add quiz.
  const [make, setMake] = useState<{
    choice: MakeQuizChoice;
    file?: string;
    run?: string;
    step: 'files' | 'pages' | 'run';
  }>({ choice: NO_FILES, step: 'files' });
  // A remount starts Convert over when going back for other questions.
  const [round, setRound] = useState(0);
  // The quiz made and not yet owned, for Cancel to take away.
  const made = useRef<string>(undefined);
  // Closed, a quiz Generate still delivers is left behind at once.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const discard = () => {
    if (made.current) trash(made.current);
    made.current = undefined;
  };
  const cancel = () => {
    discard();
    onClose();
  };
  const take = (id: string) => {
    if (!alive.current) {
      trash(id);
      return;
    }
    if (made.current && made.current !== id) discard();
    made.current = id;
    setQuizId(id);
    setStep('settings');
  };
  const back = () => {
    setMake({ choice: NO_FILES, step: 'files' });
    setRound(round + 1);
    setStep('questions');
  };

  if (!ws) return null;
  if (step === 'settings' && quizId)
    return (
      <NewAssignmentDialog
        graded={{
          onBack: back,
          quizId,
          title: <GradedTitle step={2} />,
        }}
        onClose={cancel}
        onDone={(created) => {
          made.current = undefined;
          onDone(created);
        }}
        own={own}
        presetAssignee={presetAssignee}
        workspaceId={workspaceId}
      />
    );
  return (
    <AddPracticeDialog
      graded={{
        initialTopicId: presetTopicId,
        onMade: take,
        title: <GradedTitle step={1} />,
      }}
      key={round}
      make={{
        file: make.file,
        hiddenAtFirst: true,
        initial: make.choice,
        onClose: cancel,
        // The run goes on here, and its quiz opens the Settings step.
        onConfirmed: () => undefined,
        onDone: take,
        onFile: (file) => setMake((current) => ({ ...current, file })),
        onRunBack: () =>
          setMake((current) => ({ ...current, run: undefined, step: 'pages' })),
        onShowFiles: (choice) => setMake({ choice, step: 'files' }),
        onShowPages: (choice) => setMake({ choice, step: 'pages' }),
        onStarted: (run, choice) => setMake({ choice, run, step: 'run' }),
        runId: make.run,
        step: make.step,
        workspaceId,
        workspaceName: ws.name,
      }}
    />
  );
}

/** "New graded quiz", then where it is: 1 Questions › 2 Settings. */
function GradedTitle({ step }: { step: 1 | 2 }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="min-w-0 flex-1 truncate">
        {m.assignment_new_graded_quiz()}
      </span>
      <span className="flex shrink-0 items-center gap-2 font-semibold text-sm max-sm:hidden sm:mr-9">
        <StepLabel
          current={step === 1}
          label={m.assignment_step_questions()}
          n={1}
        />
        <Icon className="text-fg-muted" name="chevronRight" size={12} />
        <StepLabel
          current={step === 2}
          label={m.assignment_step_settings()}
          n={2}
        />
      </span>
    </span>
  );
}

function StepLabel({
  current,
  label,
  n,
}: {
  current: boolean;
  label: string;
  n: number;
}) {
  return (
    <span
      aria-current={current ? 'step' : undefined}
      className={cn(
        'flex items-center gap-1.5',
        current ? 'text-fg' : 'text-fg-muted'
      )}
    >
      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full font-bold text-[11.5px]',
          current
            ? 'bg-action text-action-fg'
            : 'bg-page-hover text-fg-secondary'
        )}
      >
        {n}
      </span>
      {label}
    </span>
  );
}
