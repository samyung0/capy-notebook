import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useRefreshAssignments, useWorkspace } from '@/api/hooks';
import type { AssignmentFormReq } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import type { MakeQuizChoice } from '@/features/makeQuiz/MakeQuizDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { AddPracticeDialog } from '../practice/AddPractice';
import { NewAssignmentDialog } from './NewAssignmentDialog';

const NO_FILES: MakeQuizChoice = { answers: [], paper: [] };

/** The graded quiz made, for whoever opened the dialog. */
export type GradedQuizMade = { id: string; kind: 'marked' };

/** New graded quiz (Epo 2026-11-16, reworking 2026-11-14's boards): Settings
 * first, then Questions, whose way of getting them sends the settings with it
 * in one request (`gradedQuiz`), so the server makes the quiz and the graded
 * quiz together and nothing is left behind on Cancel. Existing quiz copies one
 * the workspace has; Generate and Convert make theirs in a run, and the graded
 * quiz arrives with its questions (saved as a draft, to be read before
 * publishing). Made, it opens on its questions; an untitled one takes its
 * quiz's name. Convert's pages and run stay in the dialog, in its own state
 * rather than the address. */
export function GradedQuizDialog({
  onClose,
  onDone,
  own,
  presetAssignee,
  presetTopicId,
  workspaceId,
}: {
  onClose: () => void;
  onDone: (made: GradedQuizMade) => void;
  /** A personal workspace's: a task for oneself. */
  own?: boolean;
  /** Opened from a member's profile (Q721): them as the only assignee. */
  presetAssignee?: string;
  /** The topic Generate quiz starts on: the profile's weakest (Q721). */
  presetTopicId?: string;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId, { errorBoundary: false });
  const [form, setForm] = useState<AssignmentFormReq>();
  const [step, setStep] = useState<'settings' | 'questions'>('settings');
  // Convert's own steps, as the address holds them for Add quiz.
  const [make, setMake] = useState<{
    choice: MakeQuizChoice;
    file?: string;
    run?: string;
    step: 'files' | 'pages' | 'run';
  }>({ choice: NO_FILES, step: 'files' });
  const navigate = useNavigate();
  const refreshAssignments = useRefreshAssignments(workspaceId);
  // Made: it opens on its questions to read or write (Epo 2026-11-16), a
  // class's on its report's Questions tab, a task for oneself on its page.
  const done = (id: string) => {
    void refreshAssignments();
    onDone({ id, kind: 'marked' });
    void navigate({
      params: { workspaceId },
      search: {
        assignment: id,
        study: 'assignments',
        ...(!own && { tab: 'questions' as const }),
      },
      to: '/workspaces/$workspaceId',
    });
  };

  if (!ws) return null;
  if (step === 'settings' || !form)
    return (
      <NewAssignmentDialog
        graded={{
          initial: form,
          onNext: (next) => {
            setForm(next);
            setStep('questions');
          },
          title: <GradedTitle step={1} />,
        }}
        onClose={onClose}
        onDone={onClose}
        own={own}
        presetAssignee={presetAssignee}
        workspaceId={workspaceId}
      />
    );
  return (
    <AddPracticeDialog
      graded={{
        form,
        initialTopicId: presetTopicId,
        onBack: () => setStep('settings'),
        onMade: done,
        own,
        title: <GradedTitle step={2} />,
      }}
      make={{
        file: make.file,
        // AI-read questions are read before the graded quiz goes out; a
        // task for oneself has no draft.
        graded: own ? form : { ...form, draft: true },
        initial: make.choice,
        onClose,
        // The run goes on here, and its graded quiz closes the dialog.
        onConfirmed: () => undefined,
        onDone: (_, assignmentId) => {
          if (assignmentId) done(assignmentId);
        },
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

/** "New graded quiz", then where it is: 1 Settings › 2 Questions. */
function GradedTitle({ step }: { step: 1 | 2 }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="min-w-0 flex-1 truncate">
        {m.assignment_new_graded_quiz()}
      </span>
      <span className="flex shrink-0 items-center gap-2 font-semibold text-sm max-sm:hidden">
        <StepLabel
          current={step === 1}
          label={m.assignment_step_settings()}
          n={1}
        />
        <Icon className="text-fg-muted" name="chevronRight" size={12} />
        <StepLabel
          current={step === 2}
          label={m.assignment_step_questions()}
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
