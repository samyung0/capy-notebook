import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useDeleteAssignment,
  useRefreshAssignments,
  useWorkspace,
} from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { userToast } from '@/components/ui/userToast';
import type { MakeQuizChoice } from '@/features/makeQuiz/MakeQuizDialog';
import { m } from '@/i18n';
import { AddPracticeDialog } from '../practice/AddPractice';
import { assignmentsLink } from '../studyRoutes';
import { useAssignmentForm } from './NewAssignmentDialog';

const NO_FILES: MakeQuizChoice = { answers: [], paper: [] };

/** The graded quiz made, for whoever opened the dialog. */
export type GradedQuizMade = { id: string; kind: 'marked' };

/** New graded quiz (Epo 2026-11-20, reversing 2026-11-16's Settings first):
 * the questions first, as what they are decides some settings (a file is
 * marked by hand out of its Points), then Settings, which starts on the
 * pick's name. Each way's Next hands its pick on, and Settings' Create sends
 * it with the settings in one request (`gradedQuiz`), so the server makes the
 * quiz and the graded quiz together and nothing is left behind on Cancel.
 * Existing file copies a quiz the workspace has or reads a file as the
 * question paper; Generate and Extract from file make theirs in a run, and the
 * graded quiz arrives with its questions (saved as a draft, to be read before
 * publishing). Settings shows in the same dialog, its steps kept mounted, so
 * Back finds the pick as it was. Made, the dialog closes and a Graded quiz
 * created toast opens it, or undoes it. Extract's pages and run stay in the
 * dialog, in its own state rather than the address. */
export function GradedQuizDialog({
  onClose,
  onDone,
  presetAssignee,
  presetTopicId,
  workspaceId,
}: {
  onClose: () => void;
  onDone: (made: GradedQuizMade) => void;
  /** Opened from a member's profile (Q721): them as the only assignee. */
  presetAssignee?: string;
  /** The topic Generate quiz starts on: the profile's weakest (Q721). */
  presetTopicId?: string;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId, { errorBoundary: false });
  const settings = useAssignmentForm({
    graded: true,
    presetAssignee,
    workspaceId,
  });
  const [onSettings, setOnSettings] = useState(false);
  // Extract's own steps, as the address holds them for New quiz.
  const [make, setMake] = useState<{
    choice: MakeQuizChoice;
    file?: string;
    run?: string;
    step: 'files' | 'pages' | 'run';
  }>({ choice: NO_FILES, step: 'files' });
  const navigate = useNavigate();
  const refreshAssignments = useRefreshAssignments(workspaceId);
  const { mutate: remove } = useDeleteAssignment(workspaceId);
  // Made: the dialog closes on the page behind it (Epo 2026-11-20, in place of
  // opening it), and the toast's Open goes to its report's Questions tab to
  // read or write. Undo, as the Assignments page's toast had, wherever it was made.
  const done = (id: string) => {
    void refreshAssignments();
    onDone({ id, kind: 'marked' });
    userToast({
      button: {
        label: m.action_open(),
        onClick: () =>
          void navigate(
            assignmentsLink(workspaceId, {
              assignment: id,
              tab: 'questions',
            })
          ),
      },
      secondary: { label: m.assignment_undo(), onClick: () => remove(id) },
      title: m.assignment_created_graded(),
      variant: 'success',
    });
  };
  const back = () => setOnSettings(false);

  if (!ws) return null;
  return (
    <AddPracticeDialog
      graded={{
        initialTopicId: presetTopicId,
        onMade: done,
        onNext: (source) => {
          settings.pick(source);
          setOnSettings(true);
        },
        settings: onSettings
          ? {
              body: (
                <form {...settings.form} className="flex flex-col gap-4 pt-1">
                  {settings.fields}
                </form>
              ),
              // Back beside Create from sm; phones have the header's arrow.
              footer: (
                <>
                  <span className="contents max-sm:hidden">
                    <Button
                      disabled={settings.saving}
                      onClick={back}
                      size="md"
                      type="button"
                      variant="outline"
                    >
                      {m.action_back()}
                    </Button>
                  </span>
                  <span className="max-sm:ml-auto sm:contents">
                    {settings.button}
                  </span>
                </>
              ),
              onBack: back,
            }
          : undefined,
        title: m.assignment_new_graded_quiz(),
      }}
      make={{
        file: make.file,
        initial: make.choice,
        onClose,
        // The run goes on here, and its graded quiz closes the dialog.
        onConfirmed: () => undefined,
        onFile: (file) => setMake((current) => ({ ...current, file })),
        onRunBack: () =>
          setMake((current) => ({
            ...current,
            run: undefined,
            step: 'pages',
          })),
        onShowFiles: (choice) => setMake({ choice, step: 'files' }),
        onShowPages: (choice) => setMake({ choice, step: 'pages' }),
        // Settings' Create started it: the run shows in its place.
        onStarted: (run, choice) => {
          setOnSettings(false);
          setMake({ choice, run, step: 'run' });
        },
        runId: make.run,
        step: make.step,
        workspaceId,
        workspaceName: ws.name,
      }}
    />
  );
}
