import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { isApiError } from '@/api/client';
import {
  useDeleteAssignment,
  usePublishAssignment,
  useRepublishAssignment,
  useSetAssignmentClosed,
  useUpdateAssignment,
  useWorkspaceMembers,
} from '@/api/hooks';
import type { Assignment, AssignmentFormReq } from '@/api/types';
import {
  DangerZone,
  SectionTitle,
  SettingRow,
} from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import {
  AnswersSelect,
  AssignToField,
  AttemptsSelect,
  assignmentBody,
  assignmentDefaults,
  assignmentResolver,
  DateField,
  Field,
  FilesField,
  GradesSelect,
  LatePenaltySelect,
  MarkingSelect,
  PointsField,
  SubmissionSelect,
  SwitchRow,
  TimeLimitSelect,
} from './assignmentFields';
import { closedItself, closeOutcomes, dayTimeLabel } from './assignmentText';
import { NoAnswersWarning } from './NoAnswersWarning';

type Asking = 'republish' | 'close' | 'delete';

/** Publish, dark, for a draft: a task's on its Settings, a graded quiz's in
 * its header. */
export function PublishButton({ assignment }: { assignment: Assignment }) {
  const { mutate: publish, isPending } = usePublishAssignment(
    assignment.workspaceId,
    assignment.id
  );
  return (
    <Button
      className="shrink-0"
      disabled={isPending}
      onClick={() =>
        publish(undefined, {
          onError: (error) =>
            userToast({
              title: errorCopy(error, m.assignment_save_failed()),
              variant: 'error',
            }),
        })
      }
    >
      {m.assignment_publish()}
    </Button>
  );
}

/**
 * An assignment's Settings (Epo 2026-11-13, B): its actions in one row on top
 * (a task's Publish while a draft, Republish, Close or Reopen), then every
 * field of its details in sections on the page, kept until Save, and Delete
 * in the danger zone. As wide as account Settings' forms (max-w-5xl).
 */
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
  const marked = assignment.kind === 'marked';
  // The quiz file's name stays out: members know the assignment, not its quiz.
  const published = draft
    ? null
    : m.assignment_last_published({ date: dayTimeLabel(assignment.postedAt) });
  // Its quiz's last save, read with the assignment (Epo 2026-11-16).
  const edited =
    manage?.quizUpdatedAt &&
    m.assignment_last_edited({ date: dayTimeLabel(manage.quizUpdatedAt) });

  return (
    <div className={cn('flex max-w-5xl flex-col gap-8', className)}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* A graded quiz's Publish sits in its header (Epo 2026-11-15). */}
          {draft && !marked && <PublishButton assignment={assignment} />}
          {quizId && !draft && !closedAt && (
            <Button
              disabled={republishing}
              iconLeft="refresh"
              onClick={() => setAsking('republish')}
              variant="outline"
            >
              {m.assignment_republish()}
            </Button>
          )}
          {!draft && !closedItself(assignment) && (
            <Button
              disabled={closing}
              iconLeft="lock"
              onClick={() =>
                marked && !closedAt ? setAsking('close') : close()
              }
              variant="outline"
            >
              {closedAt
                ? m.assignment_settings_reopen()
                : m.assignment_settings_close()}
            </Button>
          )}
        </div>
        {published && (
          <p className="t-meta text-fg-muted">
            {/* Its quiz saved since: Republish would change what members take. */}
            {manage?.quizChanged && (
              <>
                <span className="font-medium text-tint-warning-fg">
                  {m.assignment_quiz_changed()}
                </span>
                {' · '}
              </>
            )}
            {published}
            {edited && ` · ${edited}`}
          </p>
        )}
        {draft && (
          <p className="t-meta text-fg-muted">
            {m.assignment_draft_note()}
            {edited && ` · ${edited}`}
          </p>
        )}
        {draft && quizId && <NoAnswersWarning quizId={quizId} />}
      </div>
      <DetailsForm assignment={assignment} />
      <DangerZone>
        <SettingRow title={m.assignment_settings_delete()}>
          <Button
            className="shrink-0"
            disabled={deleting}
            iconLeft="trash"
            onClick={() => setAsking('delete')}
            rounded="large"
            variant="danger"
          >
            {m.action_delete()}
          </Button>
        </SettingRow>
      </DangerZone>
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
          title={m.assignment_close_title()}
        >
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[0.9375rem] sm:text-base">
            {closeOutcomes(assignment).map(({ early, text }) => (
              <li className={cn(early && 'text-solid-error')} key={text}>
                {text}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      {asking === 'delete' && (
        <ConfirmDialog
          body={
            marked
              ? m.assignment_delete_body_marked()
              : m.assignment_delete_body_unmarked()
          }
          confirmLabel={m.action_delete()}
          onClose={() => setAsking(null)}
          onConfirm={() =>
            remove(id, {
              onError: failed,
              onSuccess: () => void navigate({ search: {}, to: '.' }),
            })
          }
          open
          title={m.assignment_settings_delete()}
        />
      )}
    </div>
  );
}

/** The assignment's details on the page, as the dialog had them, in Details,
 * Marking and results, and Submissions; kept until Save, Discard puts back
 * what is saved. Its kind and quiz stay as made. */
function DetailsForm({ assignment }: { assignment: Assignment }) {
  const { workspaceId, id } = assignment;
  const marked = assignment.kind === 'marked';
  const { data: members } = useWorkspaceMembers(workspaceId, true);
  const { mutate: update, isPending: saving } = useUpdateAssignment(
    workspaceId,
    id
  );
  const {
    control,
    formState: { dirtyFields, errors, isDirty },
    handleSubmit,
    reset,
    setError,
    watch,
  } = useForm<AssignmentFormReq>({
    defaultValues: assignmentDefaults(assignment),
    mode: 'onSubmit',
    resolver: assignmentResolver,
  });
  // Saved elsewhere (Publish, Close, a co-teacher): an untouched form follows.
  useEffect(() => {
    if (!isDirty) reset(assignmentDefaults(assignment));
  }, [assignment, isDirty, reset]);
  const dueAt = watch('dueAt');
  const noLate = watch('noLate');
  const attempts = watch('attempts');
  // An Assignment taking uploads may be graded on points (Epo 2026-11-14;
  // only with uploads, 2026-11-21).
  const takesPoints = !marked && watch('allowUploads');
  const gradedAssignment = takesPoints && watch('points') !== undefined;
  const changes = Object.keys(dirtyFields).length;
  // A new total waits for a yes while anyone is graded, past members too:
  // their marks stay as given (Epo 2026-11-20).
  const [confirming, setConfirming] = useState<AssignmentFormReq | null>(null);
  const send = (values: AssignmentFormReq) =>
    update(
      // Publish alone ends a draft.
      { ...assignmentBody(values, members), draft: assignment.draft },
      {
        onError: (error) =>
          isApiError(error) && error.code === 'total_below_mark'
            ? setError('totalMarks', {
                message: m.assignment_total_below_mark(),
              })
            : setError('root', {
                message: errorCopy(error, m.assignment_save_failed()),
              }),
        onSuccess: (saved) => reset(assignmentDefaults(saved)),
      }
    );
  const save = handleSubmit((values) => {
    if (!assignment.paperFile) return send(values);
    if (values.totalMarks === undefined)
      return setError('totalMarks', { message: m.assignment_total_required() });
    if (
      values.totalMarks !== assignment.marks &&
      (assignment.manage?.graded ?? 0) > 0
    )
      return setConfirming(values);
    send(values);
  });
  const grid = 'grid gap-x-4 gap-y-3.5 sm:grid-cols-2';
  return (
    <form
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save();
      }}
    >
      <section className="flex flex-col gap-3.5">
        <SectionTitle title={m.assignment_section_details()} />
        <Field
          error={errors.title?.message}
          label={m.assignment_field_title()}
          required
        >
          <Controller
            control={control}
            name="title"
            render={({ field, fieldState }) => (
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                aria-label={m.assignment_field_title()}
                autoComplete="off"
                maxLength={120}
              />
            )}
          />
        </Field>
        <div className={grid}>
          <AssignToField control={control} workspaceId={workspaceId} />
          <Field
            error={errors.dueAt?.message}
            label={m.assignment_field_due()}
            required={marked && !assignment.draft}
          >
            <Controller
              control={control}
              name="dueAt"
              render={({ field }) => (
                <DateField
                  clearable={!marked}
                  dateOnly={!marked}
                  onChange={field.onChange}
                  value={field.value}
                />
              )}
            />
          </Field>
          {marked && (
            <>
              <Field label={m.assignment_field_time_limit()}>
                <TimeLimitSelect control={control} />
              </Field>
              <Field label={m.assignment_field_attempts()}>
                <AttemptsSelect control={control} />
                {attempts > 1 && (
                  <span className="t-meta text-fg-muted">
                    {m.assignment_highest_counts()}
                  </span>
                )}
              </Field>
            </>
          )}
        </div>
        {!marked && (
          <Field label={m.assignment_field_files()}>
            <Controller
              control={control}
              name="files"
              render={({ field }) => (
                <FilesField
                  onChange={field.onChange}
                  value={field.value}
                  workspaceId={workspaceId}
                />
              )}
            />
          </Field>
        )}
      </section>
      {(marked || gradedAssignment) && (
        <section className="flex flex-col gap-3.5">
          <SectionTitle title={m.assignment_section_marking()} />
          <div className={grid}>
            {marked && (
              <Field label={m.assignment_field_marking()}>
                <MarkingSelect
                  control={control}
                  disabled={assignment.paperFile}
                />
              </Field>
            )}
            {assignment.paperFile && (
              <PointsField
                control={control}
                error={errors.totalMarks?.message}
                label={m.assignment_field_points()}
                name="totalMarks"
              />
            )}
            <Field label={m.assignment_field_grades()}>
              <GradesSelect control={control} />
            </Field>
            {marked && (
              <Field label={m.assignment_field_answers()}>
                <AnswersSelect control={control} />
              </Field>
            )}
          </div>
        </section>
      )}
      <section className="flex flex-col gap-3.5">
        <SectionTitle title={m.assignment_section_submissions()} />
        <div className={grid}>
          {marked ? (
            <Field label={m.assignment_field_submission()}>
              <SubmissionSelect
                control={control}
                disabled={assignment.paperFile}
              />
            </Field>
          ) : (
            <SwitchRow
              control={control}
              label={m.assignment_switch_uploads()}
              name="allowUploads"
            />
          )}
          {/* Under the switch, as in New assignment (Epo 2026-11-21). */}
          {takesPoints && (
            <PointsField
              control={control}
              error={errors.points?.message}
              label={m.assignment_field_points()}
              name="points"
            />
          )}
          {marked && (
            <SwitchRow
              control={control}
              label={m.assignment_switch_shuffle()}
              name="shuffle"
            />
          )}
          {/* No late submissions goes with a due date, the penalty with marks
              or a grade. */}
          {!!dueAt && (
            <SwitchRow
              control={control}
              label={m.assignment_switch_no_late()}
              name="noLate"
            />
          )}
          {!!dueAt && (marked || gradedAssignment) && !noLate && (
            <div className="flex min-h-8 items-center justify-between gap-4">
              <InputTitle>{m.assignment_field_late_penalty()}</InputTitle>
              <LatePenaltySelect control={control} layout="row" />
            </div>
          )}
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-end gap-2 border-divider border-t pt-4">
        {errors.root?.message ? (
          <InputError className="mr-auto">{errors.root.message}</InputError>
        ) : (
          isDirty && (
            <span className="t-meta mr-auto text-fg-muted">
              {changes === 1
                ? m.assignment_changes_one()
                : m.assignment_changes({ count: changes })}
            </span>
          )
        )}
        {isDirty && (
          <Button
            disabled={saving}
            onClick={() => reset(assignmentDefaults(assignment))}
            type="button"
            variant="outline"
          >
            {m.action_discard()}
          </Button>
        )}
        <Button disabled={saving || !isDirty} type="submit">
          {m.action_save()}
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog
          body={m.assignment_total_change_body()}
          confirmLabel={m.action_save()}
          danger={false}
          onClose={() => setConfirming(null)}
          onConfirm={() => send(confirming)}
          open
          title={
            confirming.totalMarks === 1
              ? m.assignment_total_change_title_one()
              : m.assignment_total_change_title({
                  total: String(confirming.totalMarks),
                })
          }
        />
      )}
    </form>
  );
}
