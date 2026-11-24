import { useState } from 'react';
import type { Assignment } from '@/api/types';
import { PageButton } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import {
  GradedQuizDialog,
  NewAssignmentDialog,
} from './LazyNewAssignmentDialog';

/** New on a class's Assignments page (Epo 2026-11-14, board New menu): an
 * Assignment opens the form, a Graded quiz opens New graded quiz. Nobody sets
 * work for themself (Epo 2026-11-21). */
export function NewAssignmentMenu({
  onCreated,
  workspaceId,
}: {
  onCreated?: (created: Pick<Assignment, 'id' | 'kind'>) => void;
  workspaceId: string;
}) {
  const [making, setMaking] = useState<'unmarked' | 'marked' | null>(null);
  const close = () => setMaking(null);
  const done = (created: Pick<Assignment, 'id' | 'kind'>) => {
    close();
    onCreated?.(created);
  };
  return (
    <>
      <Menu
        align="end"
        items={[
          {
            icon: 'checkSquare',
            label: m.assignment_kind_assignment(),
            onClick: () => setMaking('unmarked'),
          },
          {
            icon: 'quiz',
            label: m.assignment_kind_marked(),
            onClick: () => setMaking('marked'),
          },
        ]}
        trigger={
          // Two icons already fill it out: 16px a side, not the 20px of a
          // header button with one (Epo 2026-11-19).
          <PageButton className="px-4" iconLeft="plus" iconRight="chevronDown">
            {m.assignment_new_menu()}
          </PageButton>
        }
      />
      {making === 'unmarked' && (
        <NewAssignmentDialog
          onClose={close}
          onDone={done}
          workspaceId={workspaceId}
        />
      )}
      {making === 'marked' && (
        <GradedQuizDialog
          onClose={close}
          onDone={done}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
