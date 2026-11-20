import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { qk } from '@/api/client';
import type { Assignment, FileKind, MaterialKind } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { assignmentPage } from './assignmentPage';

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
 * or shows the counted submission. Staff who assigned themselves open their own. */
export function useOpenAssignment() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (a: Assignment, manages: boolean) => {
    // Closing at a No late due date sends no event: past it, To do rereads
    // (Epo 2026-11-08) while its page says it closed.
    if (a.noLate && a.dueAt && Date.parse(a.dueAt) <= Date.now())
      void qc.invalidateQueries({ queryKey: qk.todo });
    // Whoever runs it too (a task's maker does) opens the page of the one
    // it is given to, not its report.
    return navigate(
      assignmentPage(a, {
        ...(a.mine?.countedAttemptId && a.kind === 'marked'
          ? { attempt: a.mine.countedAttemptId }
          : {}),
        ...(manages || a.own ? { own: true as const } : {}),
      })
    );
  };
}
