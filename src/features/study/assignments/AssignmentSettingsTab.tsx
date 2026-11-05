import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useDeleteAssignment,
  useRepublishAssignment,
  useSetAssignmentClosed,
} from '@/api/hooks';
import type { Assignment } from '@/api/types';
import { SettingRow } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { closedItself, dayTimeLabel } from './assignmentText';
import { NewAssignmentDialog } from './NewAssignmentDialog';
import { NoAnswersWarning } from './NoAnswersWarning';

type Asking = 'republish' | 'close' | 'delete';

/** An assignment's actions (Epo 2026-11-05, in place of its ⋮ menu). Its quiz
 * opens in its room; what a room changes reaches members on Republish. */
export function AssignmentSettingsTab({
  assignment,
  className,
}: {
  assignment: Assignment;
  className?: string;
}) {
  const navigate = useNavigate();
  const { workspaceId, id, draft, closedAt, manage } = assignment;
  const quizId = manage?.quizId;
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const { mutate: republish, isPending: republishing } = useRepublishAssignment(
    workspaceId,
    id
  );
  const { mutate: setClosed, isPending: closing } = useSetAssignmentClosed(
    workspaceId,
    id
  );
  const { mutate: remove, isPending: deleting } =
    useDeleteAssignment(workspaceId);
  const failed = (error: unknown) =>
    userToast({
      title: errorCopy(error, m.assignment_save_failed()),
      variant: 'error',
    });
  // Closing a marked one shows its quiz as practice, with its keys.
  const close = () => setClosed(!closedAt, { onError: failed });

  return (
    <div className={className}>
      <div className="flex max-w-180 flex-col gap-4">
        {quizId && (
          <SettingRow
            hint={manage?.quizTitle}
            title={m.assignment_settings_quiz()}
          >
            <UnderlineLink asChild className="text-fg">
              <Link search={{ material: quizId }} to=".">
                {m.assignment_edit_quiz()}
              </Link>
            </UnderlineLink>
          </SettingRow>
        )}
        {quizId && !draft && !closedAt && (
          <SettingRow
            hint={m.assignment_last_published({
              date: dayTimeLabel(assignment.postedAt),
            })}
            title={m.assignment_settings_republish()}
          >
            <Button
              disabled={republishing}
              iconLeft="refresh"
              onClick={() => setAsking('republish')}
              variant="outline"
            >
              {m.assignment_republish()}
            </Button>
          </SettingRow>
        )}
        <SettingRow title={m.assignment_settings_details()}>
          <Button
            iconLeft="pencil"
            onClick={() => setEditing(true)}
            variant="outline"
          >
            {m.action_edit()}
          </Button>
        </SettingRow>
        {!draft && !closedItself(assignment) && (
          <SettingRow
            title={
              closedAt
                ? m.assignment_settings_reopen()
                : m.assignment_settings_close()
            }
          >
            <Button
              disabled={closing}
              iconLeft="lock"
              onClick={() =>
                assignment.kind === 'marked' && !closedAt
                  ? setAsking('close')
                  : close()
              }
              variant="outline"
            >
              {closedAt ? m.assignment_reopen() : m.assignment_close()}
            </Button>
          </SettingRow>
        )}
        <SettingRow title={m.assignment_settings_delete()}>
          <Button
            disabled={deleting}
            iconLeft="trash"
            onClick={() => setAsking('delete')}
            variant="danger-outline"
          >
            {m.action_delete()}
          </Button>
        </SettingRow>
      </div>
      {editing && (
        <NewAssignmentDialog
          existing={assignment}
          onClose={() => setEditing(false)}
          onDone={() => setEditing(false)}
          workspaceId={workspaceId}
        />
      )}
      {asking === 'republish' && quizId && (
        <ConfirmDialog
          body={m.assignment_republish_body()}
          confirmLabel={m.assignment_republish()}
          danger={false}
          onClose={() => setAsking(null)}
          onConfirm={() => republish(undefined, { onError: failed })}
          open
          title={m.assignment_republish_title()}
        >
          <NoAnswersWarning quizId={quizId} />
        </ConfirmDialog>
      )}
      {asking === 'close' && (
        <ConfirmDialog
          confirmLabel={m.assignment_close()}
          danger={false}
          onClose={() => setAsking(null)}
          onConfirm={close}
          open
          title={m.assignment_close_confirm()}
        />
      )}
      {asking === 'delete' && (
        <ConfirmDialog
          confirmLabel={m.action_delete()}
          onClose={() => setAsking(null)}
          onConfirm={() =>
            remove(id, {
              onError: failed,
              onSuccess: () =>
                void navigate({
                  search: { study: 'assignments' as const },
                  to: '.',
                }),
            })
          }
          open
          title={m.assignment_delete_confirm()}
        />
      )}
    </div>
  );
}
