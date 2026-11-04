import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useSetAssignmentDone } from '@/api/hooks';
import type { Assignment, FileKind, MaterialRefType } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { m } from '@/i18n';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { PracticeFrame } from '../practice/studyPage';
import { BackToAssignments } from './AssignmentAttemptPage';
import { dayLabel, kindLabel } from './assignmentText';
import { useAssignmentStart } from './useAssignmentStart';

/** An assignment's page for a member (W4). An unmarked one shows its files and
 * Mark as done. A marked one goes on: to its running attempt or results, else
 * to Before you start (A0), straight in without a time limit. */
export function MemberAssignment({ assignment }: { assignment: Assignment }) {
  if (assignment.kind === 'marked')
    return <StartMarked assignment={assignment} />;
  return <Unmarked assignment={assignment} />;
}

function StartMarked({ assignment }: { assignment: Assignment }) {
  const navigate = useNavigate();
  const backToList = () =>
    void navigate({
      replace: true,
      search: { study: 'assignments' as const },
      to: '.',
    });
  const { dialog, start } = useAssignmentStart(
    assignment.workspaceId,
    backToList
  );
  const { mine } = assignment;
  const closed = !!assignment.closedAt;
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const attempt = mine?.runningAttemptId ?? mine?.latestAttemptId;
    if (attempt) {
      void navigate({
        replace: true,
        search: {
          assignment: assignment.id,
          attempt,
          study: 'assignments' as const,
        },
        to: '.',
      });
      return;
    }
    if (!closed) start(assignment);
  }, [assignment, closed, mine, navigate, start]);
  return (
    <PracticeFrame>
      {closed && !mine?.latestAttemptId && (
        <>
          <BackToAssignments />
          <h1 className="t-page-title mt-3">{assignment.title}</h1>
          <p className="mt-2 text-fg-secondary">
            {m.assignment_closed_missed()}
          </p>
        </>
      )}
      {dialog}
    </PracticeFrame>
  );
}

function Unmarked({ assignment }: { assignment: Assignment }) {
  const { mutate, isPending } = useSetAssignmentDone(assignment.workspaceId);
  const done = !!assignment.mine?.done;
  const meta = [
    kindLabel(assignment.kind),
    assignment.postedBy
      ? m.assignment_posted_by({
          date: dayLabel(assignment.postedAt),
          name: assignment.postedBy,
        })
      : m.assignment_posted({ date: dayLabel(assignment.postedAt) }),
    assignment.dueAt
      ? m.assignment_due({ date: dayLabel(assignment.dueAt) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <PracticeFrame>
      <BackToAssignments />
      <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="t-page-title">{assignment.title}</h1>
          <p className="t-meta mt-0.5 text-fg-muted">{meta}</p>
        </div>
        <Button
          disabled={isPending}
          onClick={() => mutate({ done: !done, id: assignment.id })}
          variant={done ? 'outline' : undefined}
        >
          {done ? m.assignment_mark_not_done() : m.assignment_mark_as_done()}
        </Button>
      </div>
      {assignment.files.length > 0 && (
        <section className="mt-6.5 max-w-180">
          <h2 className="t-subtitle">{m.assignment_field_files()}</h2>
          <ul className="mt-2">
            {assignment.files.map((file) => (
              <li
                className="flex min-h-10 items-center gap-2 border-divider border-b"
                key={file.fileId ?? file.materialId}
              >
                <FileIcon
                  className="size-4 shrink-0"
                  name={
                    file.fileId
                      ? fileIconName({
                          kind: file.kind as FileKind,
                          name: file.name,
                        })
                      : materialIconName(file.kind as MaterialRefType)
                  }
                />
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {file.name}
                </span>
                <UnderlineLink asChild className="text-fg">
                  <Link
                    search={
                      file.fileId
                        ? { file: file.fileId }
                        : { material: file.materialId }
                    }
                    to="."
                  >
                    {m.assignment_open()}
                  </Link>
                </UnderlineLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PracticeFrame>
  );
}
