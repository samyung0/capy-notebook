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
import { PropertyList, PropertyRow } from '@/components/ui/PropertyList';
import { userToast } from '@/components/ui/userToast';
import { ChoiceMarker } from '@/features/questions/QuestionView';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { minutesText } from './assignmentText';

/** Starting a marked assignment, from its row, the Dashboard or its link:
 * a running attempt opens; a time limit asks first, since Start starts the
 * clock (board A0), and so does one that takes uploads, which asks how (S2);
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
    navigate({ search: { assignment, attempt }, to: '.' });
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

/** Before you start (A0): the paper's size, time limit and way of answering, and when the
 * member's storage is full and the paper asks for drawings, that they save past
 * the limit (S6, Epo 2026-11-08). One that takes uploads asks how it is
 * answered first (S2, Epo 2026-11-19), Upload turned off while storage is full;
 * upload-only starts as an upload. */
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
  const { allowUploads, uploadOnly } = assignment;
  const choose = allowUploads && !uploadOnly;
  const [upload, setUpload] = useState(uploadOnly);
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
        {/* What it holds, as an item's properties (Epo 2026-11-19). */}
        <PropertyList className="mt-3">
          <PropertyRow
            label={m.question_ui_questions()}
            value={String(assignment.questions)}
          />
          <PropertyRow
            label={m.question_ui_part_marks()}
            value={String(assignment.marks)}
          />
          {!!assignment.timeLimitMin && (
            <PropertyRow
              label={m.assignment_field_time_limit()}
              value={minutesText(assignment.timeLimitMin)}
            />
          )}
          {assignment.attempts > 1 && (
            <PropertyRow
              label={m.assignment_field_attempts()}
              value={String(assignment.attempts)}
            />
          )}
          {!choose && (
            <PropertyRow
              label={m.assignment_field_submission()}
              value={
                uploadOnly
                  ? m.assignment_mode_upload()
                  : m.assignment_mode_online()
              }
            />
          )}
        </PropertyList>
        {choose && (
          <div className="mt-4 flex flex-col gap-2.5">
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
                disabled={full}
                hint={m.assignment_mode_upload_hint()}
                label={m.assignment_mode_upload()}
                on={upload}
                onPick={() => setUpload(true)}
              />
            </div>
            <p className="t-meta text-fg-secondary">
              {m.assignment_mode_locked()}
            </p>
          </div>
        )}
        {full && (allowUploads || assignment.drawingParts) && (
          <p className="t-meta mt-3 rounded-lg bg-tint-warning px-3 py-2.5 text-tint-warning-fg">
            {uploadOnly
              ? m.assignment_storage_full_upload_only()
              : allowUploads
                ? m.assignment_storage_full_upload()
                : m.assignment_storage_full_drawings()}
          </p>
        )}
        <FormAlert errorId={error?.errorId} message={error?.message ?? null} />
        <DialogFooter>
          <Button disabled={starting} onClick={onCancel} variant="ghost">
            {m.assignment_not_now()}
          </Button>
          <Button
            disabled={starting || (upload && full)}
            onClick={() => onStart(upload)}
          >
            {m.assignment_start()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One way to answer, picked as a radio (S2). */
function ModeCard({
  disabled,
  hint,
  label,
  on,
  onPick,
}: {
  disabled?: boolean;
  hint: string;
  label: string;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      aria-checked={on}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
        on && 'border-solid-accent-1 ring-1 ring-solid-accent-1'
      )}
      disabled={disabled}
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
