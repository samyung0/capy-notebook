import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useStartAssignment } from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
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
 * clock (board A0); no limit opens straight away. */
export function useAssignmentStart(workspaceId: string, onCancel?: () => void) {
  const navigate = useNavigate();
  const { mutate, isPending } = useStartAssignment(workspaceId);
  const [asking, setAsking] = useState<Assignment | null>(null);
  const open = (assignment: string, attempt: string) =>
    navigate({
      search: { assignment, attempt, study: 'assignments' as const },
      to: '.',
    });
  const run = (a: Assignment) =>
    mutate(a.id, {
      onError: (error) =>
        userToast({
          title: errorCopy(error, m.assignment_start_failed()),
          variant: 'error',
        }),
      onSuccess: (attempt) => {
        setAsking(null);
        void open(a.id, attempt.id);
      },
    });
  const start = (a: Assignment) => {
    if (a.mine?.runningAttemptId) void open(a.id, a.mine.runningAttemptId);
    else if (a.timeLimitMin) setAsking(a);
    else run(a);
  };
  const dialog = asking && (
    <BeforeYouStart
      assignment={asking}
      onCancel={() => {
        setAsking(null);
        onCancel?.();
      }}
      onStart={() => run(asking)}
      starting={isPending}
    />
  );
  return { dialog, start, starting: isPending };
}

/** Before you start (A0): only the time and the paper's size. */
function BeforeYouStart({
  assignment,
  onCancel,
  onStart,
  starting,
}: {
  assignment: Assignment;
  onCancel: () => void;
  onStart: () => void;
  starting: boolean;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onCancel()} open>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-130"
        compact
        showCloseButton={false}
      >
        <DialogTitle className="truncate" closable={false}>
          {assignment.title}
        </DialogTitle>
        <div className="mt-2 flex items-center gap-4 rounded-xl bg-tint-accent-1 px-5 py-4.5">
          <span className="grid size-16 shrink-0 place-items-center rounded-full bg-surface text-tint-accent-1-fg">
            <Icon name="clock" size={32} />
          </span>
          <div className="min-w-0">
            <p className="font-extrabold text-[1.875rem] leading-tight tracking-[-0.02rem]">
              {minutesText(assignment.timeLimitMin ?? 0)}
            </p>
            <p className="t-meta text-fg-secondary">
              {m.assignment_timer_starts()}
            </p>
          </div>
        </div>
        <p className="t-meta mt-3.5 text-fg-secondary">
          {paperMeta(assignment)}
        </p>
        <DialogFooter>
          <Button disabled={starting} onClick={onCancel} variant="ghost">
            {m.assignment_not_now()}
          </Button>
          <Button disabled={starting} onClick={onStart}>
            {m.assignment_start()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
