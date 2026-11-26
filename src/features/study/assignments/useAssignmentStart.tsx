import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useStartAssignment } from '@/api/hooks';
import {
  SUBMISSION_BYTES_MAX,
  SUBMISSION_FILES_MAX,
} from '@/api/limits.generated';
import type { Assignment } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { userToast } from '@/components/ui/userToast';
import { ChoiceMarker } from '@/features/questions/QuestionView';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { attemptLink } from '../studyRoutes';
import { startsLeft } from './assignmentText';

/** Starting a marked assignment, from its page, To do's Start quiz or its
 * results' Try again: a
 * running attempt opens, and one that may still be answered online or by
 * upload asks which (S2); anything else starts straight away, an upload-only
 * one as an upload (Epo 2026-11-25: the page shows its facts, so the dialog is
 * only for choosing). Closing the dialog leaves the page as it was. */
export function useAssignmentStart(workspaceId: string) {
  const navigate = useNavigate();
  const { mutate, isPending } = useStartAssignment(workspaceId);
  const [asking, setAsking] = useState<Assignment | null>(null);
  const [startError, setStartError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  // The attempt's own page (Epo 2026-11-25), from To do as from the workspace.
  const open = (attempt: string) => navigate(attemptLink(attempt));
  const run = (a: Assignment, upload: boolean) => {
    setStartError(null);
    mutate(
      { id: a.id, upload },
      {
        onError: (error) => {
          const message = errorCopy(error, m.assignment_start_failed());
          // The choice stays open with the refusal; with no dialog, a toast.
          if (asking) {
            setStartError({ errorId: unexpectedErrorId(error), message });
          } else {
            userToast({ title: message, variant: 'error' });
          }
        },
        onSuccess: (attempt) => {
          setAsking(null);
          void open(attempt.id);
        },
      }
    );
  };
  const start = (a: Assignment) => {
    const left = startsLeft(a);
    if (a.mine?.runningAttemptId) void open(a.mine.runningAttemptId);
    else if (left.online && left.upload) setAsking(a);
    else run(a, !left.online);
  };
  const dialog = asking && (
    <ChooseMode
      assignment={asking}
      error={startError}
      onCancel={() => {
        setAsking(null);
        setStartError(null);
      }}
      onStart={(upload) => run(asking, upload)}
      starting={isPending}
    />
  );
  return { dialog, start, starting: isPending };
}

/** Choosing how a paper is answered, before its first start only (S2, Epo
 * 2026-11-19): the choice holds for good (`startsLeft`, Epo 2026-11-25). */
function ChooseMode({
  assignment,
  error,
  onCancel,
  onStart,
  starting,
}: {
  assignment: Assignment;
  error: { errorId: string | null; message: string } | null;
  onCancel: () => void;
  onStart: (upload: boolean) => void;
  starting: boolean;
}) {
  const [upload, setUpload] = useState(false);
  // The shared dialog (Epo 2026-11-25): its title wraps, Cancel and the
  // corner close, the accent primary.
  return (
    <SimpleDialog
      action={
        <Button
          disabled={starting}
          onClick={() => onStart(upload)}
          size="lg"
          variant="accent"
        >
          {m.assignment_start()}
        </Button>
      }
      onClose={() => !starting && onCancel()}
      open
      pending={starting}
      title={assignment.title}
      width={520}
    >
      <div className="flex flex-col gap-2.5 pt-2">
        <p className="font-semibold" id="assignment-how">
          {m.assignment_how_answer()}
        </p>
        <div
          aria-labelledby="assignment-how"
          className="flex flex-col gap-2.5"
          role="radiogroup"
        >
          <ModeCard
            hint={m.assignment_mode_online_hint()}
            label={m.assignment_mode_online()}
            on={!upload}
            onPick={() => setUpload(false)}
          />
          <ModeCard
            hint={m.assignment_mode_upload_hint({
              files: SUBMISSION_FILES_MAX,
              // Whole megabytes: "30 MB", not "30.0 MB".
              mb: SUBMISSION_BYTES_MAX / 1024 ** 2,
            })}
            label={m.assignment_mode_upload()}
            on={upload}
            onPick={() => setUpload(true)}
          />
        </div>
        <p className="t-meta text-fg-secondary">{m.assignment_mode_locked()}</p>
      </div>
      <FormAlert errorId={error?.errorId} message={error?.message ?? null} />
    </SimpleDialog>
  );
}

/** One way to answer, picked as a radio (S2). */
function ModeCard({
  hint,
  label,
  on,
  onPick,
}: {
  hint: string;
  label: string;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      aria-checked={on}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
        on && 'border-solid-accent-1 ring-1 ring-solid-accent-1'
      )}
      onClick={onPick}
      role="radio"
      type="button"
    >
      <ChoiceMarker
        checked={on}
        className="mt-0.5"
        multiple={false}
        state="selected"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-bold">{label}</span>
        <span className="t-meta text-fg-secondary">{hint}</span>
      </span>
    </button>
  );
}
