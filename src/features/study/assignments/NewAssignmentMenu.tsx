import { useState } from 'react';
import type { Assignment } from '@/api/types';
import { Button, PageButton } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import {
  GradedQuizDialog,
  NewAssignmentDialog,
} from './LazyNewAssignmentDialog';

/** New on the Assignments page, a personal workspace's To do and the
 * Dashboard's To do (Epo 2026-11-14, board New menu): an Assignment (a Task
 * for oneself) opens the form, a Graded quiz opens New graded quiz. */
export function NewAssignmentMenu({
  onCreated,
  own,
  small = false,
  workspaceId,
}: {
  onCreated?: (assignment: Assignment) => void;
  /** A personal workspace's: tasks for oneself. */
  own: boolean;
  /** The Dashboard section's small outline button instead of the page's. */
  small?: boolean;
  workspaceId: string;
}) {
  const [making, setMaking] = useState<'unmarked' | 'marked' | null>(null);
  const close = () => setMaking(null);
  const done = (assignment: Assignment) => {
    close();
    onCreated?.(assignment);
  };
  return (
    <>
      <Menu
        align="end"
        items={[
          {
            icon: 'checkSquare',
            label: own
              ? m.assignment_kind_task()
              : m.assignment_kind_assignment(),
            onClick: () => setMaking('unmarked'),
          },
          {
            icon: 'quiz',
            label: m.assignment_kind_marked(),
            onClick: () => setMaking('marked'),
          },
        ]}
        trigger={
          small ? (
            <Button
              className="px-2.5"
              iconLeft="plus"
              iconRight="chevronDown"
              size="sm"
              variant="outline"
            >
              {m.assignment_new_menu()}
            </Button>
          ) : (
            <PageButton iconLeft="plus" iconRight="chevronDown">
              {m.assignment_new_menu()}
            </PageButton>
          )
        }
      />
      {making === 'unmarked' && (
        <NewAssignmentDialog
          onClose={close}
          onDone={done}
          own={own}
          title={own ? m.todo_new_task() : undefined}
          workspaceId={workspaceId}
        />
      )}
      {making === 'marked' && (
        <GradedQuizDialog
          onClose={close}
          onDone={done}
          own={own}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
