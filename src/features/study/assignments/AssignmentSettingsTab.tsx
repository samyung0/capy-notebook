import { Link, useNavigate } from '@tanstack/react-router';
import { type ComponentProps, useState } from 'react';
import {
  useDeleteAssignment,
  usePublishAssignment,
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

/** The rows' one width, so their buttons line up. */
function RowButton(props: ComponentProps<typeof Button>) {
  return (
    <Button className="w-32 justify-start" variant="ghost-hover" {...props} />
  );
}

/** An assignment's actions (Epo 2026-11-05, in place of its ⋮ menu), under
 * Publish while it is a draft. Its quiz opens in its room; what a room changes
 * reaches members on Republish. */
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
  const { mutate: publish, isPending: publishing } = usePublishAssignment(
    workspaceId,
    id
  );
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
        {draft && (
          <SettingRow
            hint={m.assignment_draft_note()}
            title={m.assignment_settings_publish()}
          >
            <Button
              className="w-32"
              disabled={publishing}
              onClick={() => publish(undefined, { onError: failed })}
            >
              {m.assignment_publish()}
            </Button>
          </SettingRow>
        )}
        {draft && quizId && <NoAnswersWarning quizId={quizId} />}
        {quizId && (
          <SettingRow
            hint={manage?.quizTitle}
            title={m.assignment_settings_quiz()}
          >
            <UnderlineLink
              asChild
              className="w-32 justify-start text-fg"
              size="md"
              variant="ghost-hover"
            >
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
            <RowButton
              disabled={republishing}
              iconLeft="refresh"
              onClick={() => setAsking('republish')}
            >
              {m.assignment_republish()}
            </RowButton>
          </SettingRow>
        )}
        <SettingRow title={m.assignment_settings_details()}>
          <RowButton iconLeft="pencil" onClick={() => setEditing(true)}>
            {m.action_edit()}
          </RowButton>
        </SettingRow>
        {!draft && !closedItself(assignment) && (
          <SettingRow
            title={
              closedAt
                ? m.assignment_settings_reopen()
                : m.assignment_settings_close()
            }
          >
            <RowButton
              disabled={closing}
              iconLeft="lock"
              onClick={() =>
                assignment.kind === 'marked' && !closedAt
                  ? setAsking('close')
                  : close()
              }
            >
              {closedAt ? m.assignment_reopen() : m.assignment_close()}
            </RowButton>
          </SettingRow>
        )}
        <SettingRow title={m.assignment_settings_delete()}>
          <RowButton
            disabled={deleting}
            iconLeft="trash"
            onClick={() => setAsking('delete')}
            variant="danger-light"
          >
            {m.action_delete()}
          </RowButton>
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
