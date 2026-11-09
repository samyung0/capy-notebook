import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useMe, useStartAssignment } from '@/api/hooks';
import { type Assignment, StorageUsageLevel } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { minutesText } from './assignmentText';

/** "12 questions · 40 marks". */
export function paperMeta(a: Pick<Assignment, 'questions' | 'marks'>) {
  return `${
    a.questions === 1
      ? m.question_ui_one_question()
      : m.question_ui_question_count({ count: a.questions })
  } · ${a.marks === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count: a.marks })}`;
}

/** Starting a marked assignment, from its row, the Dashboard or its link:
 * a running attempt opens; a time limit asks first, since Start starts the
 * clock (board A0), and so does one that takes uploads, which asks how (S4);
 * otherwise it opens straight away. */
export function useAssignmentStart(workspaceId: string, onCancel?: () => void) {
  const navigate = useNavigate();
  const { mutate, isPending } = useStartAssignment(workspaceId);
  const [asking, setAsking] = useState<Assignment | null>(null);
  const [startError, setStartError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const open = (assignment: string, attempt: string) =>
    navigate({
      search: { assignment, attempt, study: 'assignments' as const },
      to: '.',
    });
  const run = (a: Assignment, upload = false) => {
    setStartError(null);
    mutate(
      { id: a.id, upload },
      {
        onError: (error) => {
          const message = errorCopy(error, m.assignment_start_failed());
          // Before you start stays open with the refusal; with no dialog, a toast.
          if (asking) {
            setStartError({ errorId: unexpectedErrorId(error), message });
          } else {
            userToast({ title: message, variant: 'error' });
          }
        },
        onSuccess: (attempt) => {
          setAsking(null);
          void open(a.id, attempt.id);
        },
      }
    );
  };
  const start = (a: Assignment) => {
    if (a.mine?.runningAttemptId) void open(a.id, a.mine.runningAttemptId);
    else if (a.timeLimitMin || a.allowUploads) setAsking(a);
    else run(a);
  };
  const dialog = asking && (
    <BeforeYouStart
      assignment={asking}
      error={startError}
      onCancel={() => {
        setAsking(null);
        setStartError(null);
        onCancel?.();
      }}
      onStart={(upload) => run(asking, upload)}
      starting={isPending}
    />
  );
  return { dialog, start, starting: isPending };
}

/** Before you start (A0): only the time and the paper's size, and when the
 * member's storage is full and the paper asks for drawings, that they save past
 * the limit (S6, Epo 2026-11-08). An assignment that takes uploads offers
 * Upload file beside Attempt online (S4), turned off while storage is full. */
function BeforeYouStart({
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
  const { data: me } = useMe({ errorBoundary: false });
  const full = me?.account?.storageUsage === StorageUsageLevel.full;
  const uploads = assignment.allowUploads;
  return (
    <Dialog onOpenChange={(open) => !open && !starting && onCancel()} open>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-130"
        compact
        showCloseButton={false}
      >
        <DialogTitle className="truncate" closable={false}>
          {assignment.title}
        </DialogTitle>
        {!!assignment.timeLimitMin && (
          <div className="mt-2 flex items-center gap-4 rounded-xl bg-tint-accent-1 px-5 py-4.5">
            <span className="grid size-16 shrink-0 place-items-center rounded-full bg-surface text-tint-accent-1-fg">
              <Icon name="clock" size={32} />
            </span>
            <div className="min-w-0">
              <p className="font-extrabold text-[1.875rem] leading-tight tracking-[-0.02rem]">
                {minutesText(assignment.timeLimitMin)}
              </p>
              <p className="t-meta text-fg-secondary">
                {uploads
                  ? m.assignment_timer_starts_uploads()
                  : m.assignment_timer_starts()}
              </p>
            </div>
          </div>
        )}
        <p className="t-meta mt-3.5 text-fg-secondary">
          {paperMeta(assignment)}
        </p>
        {full && (uploads || assignment.drawingParts) && (
          <p className="t-meta mt-3 rounded-lg bg-tint-warning px-3 py-2.5 text-tint-warning-fg">
            {uploads
              ? m.assignment_storage_full_upload()
              : m.assignment_storage_full_drawings()}
          </p>
        )}
        <FormAlert errorId={error?.errorId} message={error?.message ?? null} />
        <DialogFooter className="max-sm:flex-wrap max-sm:justify-end">
          <Button disabled={starting} onClick={onCancel} variant="ghost">
            {m.assignment_not_now()}
          </Button>
          {uploads && (
            <Button
              disabled={starting || full}
              onClick={() => onStart(true)}
              variant="outline"
            >
              {m.assignment_upload_file()}
            </Button>
          )}
          <Button disabled={starting} onClick={() => onStart(false)}>
            {uploads ? m.assignment_attempt_online() : m.assignment_start()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
