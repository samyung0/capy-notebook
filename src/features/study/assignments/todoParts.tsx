import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { qk } from '@/api/client';
import type { Assignment, FileKind, MaterialKind } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { assignmentsLink, attemptLink } from '../studyRoutes';

/** "4 submissions to grade": a graded Assignment's submissions with no
 * grade (Epo 2026-11-26). */
export const submissionsText = (count: number) =>
  count === 1
    ? m.todo_submissions_waiting_one()
    : m.todo_submissions_waiting({ count });

/** Only submissions to grade wait on this approval row, no answers (a graded
 * Assignment's). */
export const gradesOnly = (a: Assignment) =>
  !a.manage?.toApprove && (a.manage?.toGrade ?? 0) > 0;

/** A chip naming a quiz: the assignment's quill, tinted (Epo 2026-11-03). */
export function WorkChip({ title }: { title: string }) {
  return (
    // At most 288px, a long name cut short (Epo 2026-11-13).
    <span className="inline-flex h-5.5 min-w-0 max-w-72 items-center gap-1 rounded-md bg-tint-accent-1 px-1.75 font-semibold text-[13px] text-tint-accent-1-fg">
      <Icon
        className="shrink-0 text-(--ctp-teal)"
        name="quillWrite"
        size={14}
      />
      <span className="truncate" title={title}>
        {title}
      </span>
    </span>
  );
}

/** A section's small heading on a paper's pages: Question paper, Your
 * answers, Feedback. */
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'font-bold text-[11px] text-fg-muted uppercase leading-none tracking-[.06rem]',
        className
      )}
    >
      {children}
    </p>
  );
}

/** An assignment file's or material's icon. */
export const assignmentFileIcon = (file: Assignment['files'][number]) =>
  file.fileId
    ? fileIconName({ kind: file.kind as FileKind, name: file.name })
    : materialIconName(file.kind as MaterialKind);

/** Opens an assignment's page (Epo 2026-11-05): it starts or continues the work,
 * or shows the counted submission. Staff who gave it to themselves ("You")
 * open their own. */
export function useOpenAssignment() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (a: Assignment, manages: boolean) => {
    // Closing at a No late due date sends no event: past it, To do rereads
    // (Epo 2026-11-08) while its page says it closed.
    if (a.noLate && a.dueAt && Date.parse(a.dueAt) <= Date.now())
      void qc.invalidateQueries({ queryKey: qk.todo });
    // A member's counted submission opens on its own page (Epo 2026-11-25).
    if (a.mine?.countedAttemptId && a.kind === 'marked' && !manages)
      return navigate(attemptLink(a.mine.countedAttemptId));
    return navigate(
      assignmentsLink(a.workspaceId, {
        assignment: a.id,
        ...(a.mine?.countedAttemptId && a.kind === 'marked'
          ? { attempt: a.mine.countedAttemptId }
          : {}),
        ...(manages ? { own: true as const } : {}),
      })
    );
  };
}
