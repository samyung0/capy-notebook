import { type ReactNode, useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  useCreateAssignment,
  useMe,
  useUpdateAssignment,
  useWorkspaceMembers,
} from '@/api/hooks';
import type { Assignment, AssignmentFormReq, Workspace } from '@/api/types';
import { Accordion } from '@/components/ui/Accordion';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { questionsLabel } from '../practice/practiceText';
import { studyView } from '../practice/studyView';
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
  gradedSettingsResolver,
  LatePenaltySelect,
  MarkingSelect,
  PointsField,
  SubmissionSelect,
  SwitchRow,
  TimeLimitSelect,
} from './assignmentFields';
import { advancedStartsOpen } from './assignmentText';
import { type TaskFile, TaskFilesField } from './TaskFiles';

/** The Workspace field's value for a task with no workspace. */
const NO_WORKSPACE = 'none';

/** New assignment and its edit (boards A1, A1b, A1d; Task, Epo 2026-11-14): a
 * new one is an Assignment (a task in a personal workspace), a title with
 * optional files; New's Graded quiz opens New graded quiz, whose first step,
 * Settings, this is (`graded`, Epo 2026-11-16): Next hands its values on to the
 * Questions step, which sends them with the questions. Editing keeps the kind
 * and the quiz.
 *
 * It is also the form of a task one sets oneself (`own`, Epo 2026-11-10: New
 * task for anyone in a personal workspace and a class's viewer members), one
 * dialog showing the fields that apply (Epo 2026-11-11): everything an
 * assignment has but Assign to, as it is for its maker alone
 * (`checkOwnTask`), with its files from any workspace or none. To do's Add task
 * passes `workspaces`: Workspace is then the first field, starting on none, and
 * the fields follow the workspace picked without the dialog reopening.
 */
export function NewAssignmentDialog({
  existing,
  graded,
  onClose,
  onDone,
  own,
  presetAssignee,
  title,
  workspaceId,
  workspaces,
}: {
  existing?: Assignment;
  /** New graded quiz's Settings step: the values it starts on (when back from
   * Questions), and Next with the form's. */
  graded?: {
    initial?: AssignmentFormReq;
    onNext: (form: AssignmentFormReq) => void;
    title: ReactNode;
  };
  onClose: () => void;
  onDone: (assignment: Assignment) => void;
  /** A new task for oneself, where the page knows the viewer gives out no
   * assignments here; with `workspaces` the workspace picked decides. */
  own?: boolean;
  /** Opened from a member's profile (Q721): them as the only assignee. */
  presetAssignee?: string;
  /** A new one's heading where the page has its own word for it (New task, To
   * do's Add task); New assignment without. */
  title?: string;
  /** Empty for a task with no workspace; with `workspaces`, where it starts. */
  workspaceId: string;
  /** To do's Add task: the workspaces its Workspace field offers. */
  workspaces?: Workspace[];
}) {
  const [picked, setPicked] = useState(workspaceId);
  const wsId = workspaces ? picked : workspaceId;
  const runs = (id: string) =>
    !!studyView(workspaces?.find((ws) => ws.id === id)).manages;
  // A task for oneself: only a class's staff give out assignments.
  const isOwn = existing ? existing.own : workspaces ? !runs(wsId) : !!own;
  const [pickedFiles, setPickedFiles] = useState<TaskFile[]>([]);
  const { data: me } = useMe();
  const manage = existing?.manage;
  const formId = useId();
  const { data: members } = useWorkspaceMembers(wsId, !isOwn);
  const {
    clearErrors,
    control,
    formState: { errors },
    handleSubmit,
    setError,
    setValue,
    watch,
  } = useForm<AssignmentFormReq>({
    defaultValues:
      graded?.initial ??
      assignmentDefaults(
        existing,
        existing
          ? {}
          : {
              assignAll: !presetAssignee,
              assignees: presetAssignee ? [presetAssignee] : [],
              kind: graded ? 'marked' : 'unmarked',
            }
      ),
    mode: 'onSubmit',
    resolver: graded ? gradedSettingsResolver : assignmentResolver,
  });
  const kind = watch('kind');
  const dueAt = watch('dueAt');
  const noLate = watch('noLate');
  const attempts = watch('attempts');
  const draft = watch('draft');
  // A class's Assignment may be graded on points (Epo 2026-11-14), which
  // brings Show grades and the late penalty; a task never is.
  const takesPoints = !isOwn && kind === 'unmarked';
  const gradedAssignment = takesPoints && watch('points') !== undefined;
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      advancedStartsOpen(existing) ||
      !!manage?.shuffle ||
      (existing?.kind === 'unmarked' && manage?.showGrades === 'manual')
  );
  // No late submissions goes with a due date on either kind (Epo 2026-11-09),
  // the penalty with a marked one's marks; a published one is past being a
  // draft, and a task for oneself has none: a draft is an assignment kept
  // from its members until published.
  const hasPolicy = !!dueAt;
  const hasDraft = !isOwn && (!existing || existing.draft);
  const { mutate: create, isPending: creating } = useCreateAssignment(wsId);
  const { mutate: update, isPending: updating } = useUpdateAssignment(
    wsId,
    existing?.id ?? ''
  );
  // The Workspace field: what is typed stays, and what belongs to the
  // workspace left behind goes (its people, an assignment's files; a task's
  // come from anywhere, so they stay from task to task).
  const pickWorkspace = (next: string) => {
    if (!(isOwn && !runs(next))) setValue('files', []);
    setValue('assignAll', true);
    setValue('assignees', []);
    if (!runs(next)) setValue('draft', false);
    clearErrors();
    setPicked(next);
  };
  const saving = creating || updating;
  const submit = handleSubmit((values) => {
    if (isOwn && !me) return;
    const body: AssignmentFormReq = {
      ...assignmentBody(values, members),
      // A task is for its maker alone, and has no points.
      ...(isOwn && {
        assignAll: false,
        assignees: me ? [me.id] : [],
        points: undefined,
      }),
    };
    if (graded) {
      graded.onNext(body);
      return;
    }
    const options = {
      onError: (error: unknown) =>
        setError('root', {
          message: errorCopy(error, m.assignment_save_failed()),
        }),
      onSuccess: onDone,
    };
    if (existing) update(body, options);
    else create(body, options);
  });
  // In the phone header and the form's footer: either one, or Enter in a field,
  // submits the form once.
  const createButton = (
    <Button
      disabled={saving || (isOwn && !me)}
      form={formId}
      type="submit"
      variant="accent"
    >
      {graded
        ? m.action_next()
        : existing
          ? m.action_save()
          : m.assignment_create()}
    </Button>
  );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        cardClassName={cn(graded && 'h-full')}
        cardScrollContainerClassName="sm:px-6.25"
        // New graded quiz's Settings takes its Questions' frame, so Next and
        // Back change only what is in it (Epo 2026-11-19).
        className={cn(
          graded
            ? 'flex flex-col sm:h-[min(680px,88dvh)] sm:max-w-180'
            : 'sm:max-w-150'
        )}
        // New graded quiz's steps both have the corner close.
        showCloseButton={!!graded}
      >
        <DialogTitle action={createButton}>
          {graded
            ? graded.title
            : existing
              ? isOwn
                ? m.todo_edit_task()
                : m.assignment_edit()
              : (title ?? m.assignment_new())}
        </DialogTitle>
        <form
          className={cn('flex flex-col gap-4 pt-1', graded && 'flex-1')}
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void submit();
          }}
        >
          {workspaces && (
            <Field label={m.todo_fact_workspace()}>
              <Select
                onValueChange={(next) =>
                  pickWorkspace(next === NO_WORKSPACE ? '' : next)
                }
                value={wsId || NO_WORKSPACE}
              >
                <SelectTrigger aria-label={m.todo_fact_workspace()}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    iconAndValue={{
                      icon: 'circleDashed',
                      label: m.todo_no_workspace(),
                    }}
                    value={NO_WORKSPACE}
                  />
                  {workspaces.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <img
                          alt=""
                          className="size-4.5 shrink-0 -translate-y-px rounded-[4px]"
                          src={iconUrl(option.iconId)}
                        />
                        <span className="truncate">{option.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {!graded && kind === 'marked' && (
            <Field label={m.assignment_field_quiz()}>
              <div className="flex min-h-7 items-center gap-2">
                <FileIcon
                  className="size-4 shrink-0"
                  name={materialIconName('quiz')}
                />
                <span className="truncate font-semibold">
                  {manage?.quizTitle}
                </span>
                {existing && (
                  <span className="t-meta shrink-0 text-fg-muted">
                    {questionsLabel(existing.questions)}
                  </span>
                )}
              </div>
            </Field>
          )}
          <Field
            error={errors.title?.message}
            label={m.assignment_field_title()}
            required={!graded}
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
                  // Left empty, a graded quiz is named after its quiz.
                  placeholder={
                    graded ? m.assignment_title_from_quiz() : undefined
                  }
                />
              )}
            />
          </Field>
          {/* A plain task's due date stands alone: it is for nobody else. */}
          <div
            className={cn(
              'grid gap-4',
              !(isOwn && kind === 'unmarked') && 'sm:grid-cols-2'
            )}
          >
            <Field
              error={errors.dueAt?.message}
              label={m.assignment_field_due()}
              required={kind === 'marked' && !draft}
            >
              <Controller
                control={control}
                name="dueAt"
                render={({ field }) => (
                  <DateField
                    clearable={kind === 'unmarked'}
                    dateOnly={kind === 'unmarked'}
                    onChange={field.onChange}
                    value={field.value}
                  />
                )}
              />
            </Field>
            {kind === 'marked' ? (
              <Field label={m.assignment_field_time_limit()}>
                <TimeLimitSelect control={control} />
              </Field>
            ) : (
              // A task for oneself is for nobody else.
              !isOwn && <AssignToField control={control} workspaceId={wsId} />
            )}
            {kind === 'marked' && (
              <>
                <Field label={m.assignment_field_attempts()}>
                  <AttemptsSelect control={control} />
                  {attempts > 1 && (
                    <span className="t-meta text-fg-muted">
                      {m.assignment_highest_counts()}
                    </span>
                  )}
                </Field>
                {!isOwn && (
                  <AssignToField control={control} workspaceId={wsId} />
                )}
              </>
            )}
          </div>
          {/* Points in a row of their own under Due and Assign to (board
              Task, Epo 2026-11-14). */}
          {takesPoints && (
            <div className="grid gap-4 sm:grid-cols-2">
              <PointsField control={control} error={errors.points?.message} />
            </div>
          )}
          {/* C2 (Epo 2026-11-08): Files below Due and Assign to, then the switch:
              members hand in files with Hand in. */}
          {kind === 'unmarked' && (
            <>
              <Field label={m.assignment_field_files()}>
                <Controller
                  control={control}
                  name="files"
                  render={({ field }) =>
                    // A task's files come from anywhere (Epo 2026-11-11); an
                    // assignment's are its class's, for its members to open.
                    isOwn ? (
                      <TaskFilesField
                        onChange={field.onChange}
                        onPicked={(file) =>
                          setPickedFiles((rows) => [...rows, file])
                        }
                        picked={pickedFiles}
                        saved={existing?.files ?? []}
                        value={field.value}
                      />
                    ) : (
                      <FilesField
                        onChange={field.onChange}
                        value={field.value}
                        workspaceId={wsId}
                      />
                    )
                  }
                />
              </Field>
              <SwitchRow
                control={control}
                label={m.assignment_switch_uploads()}
                name="allowUploads"
              />
            </>
          )}
          {kind === 'marked' && (
            <div className="flex flex-col gap-2 pt-0.5">
              {/* Marking (A4, Epo 2026-11-06) on its own row, then when
                  members see grades and keys (C4, C3; board Graded quiz 2
                  Settings, Epo 2026-11-14). */}
              <div className="mb-1 grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label={m.assignment_field_marking()}>
                    <MarkingSelect control={control} />
                  </Field>
                </div>
                <Field label={m.assignment_field_grades()}>
                  <GradesSelect control={control} />
                </Field>
                <Field label={m.assignment_field_answers()}>
                  <AnswersSelect control={control} />
                </Field>
                {/* C1 (Epo 2026-11-08), as a mode (Epo 2026-11-19). */}
                <div className="sm:col-span-2">
                  <Field label={m.assignment_field_submission()}>
                    <SubmissionSelect control={control} />
                  </Field>
                </div>
              </div>
            </div>
          )}
          {(kind === 'marked' || hasDraft || hasPolicy || gradedAssignment) && (
            <Accordion
              label={m.assignment_advanced()}
              onToggle={() => setAdvancedOpen(!advancedOpen)}
              open={advancedOpen}
            >
              {kind === 'marked' && (
                <SwitchRow
                  control={control}
                  label={m.assignment_switch_shuffle()}
                  name="shuffle"
                />
              )}
              {hasPolicy && (
                <SwitchRow
                  control={control}
                  label={m.assignment_switch_no_late()}
                  name="noLate"
                />
              )}
              {gradedAssignment && (
                <div className="flex min-h-8 items-center justify-between gap-4">
                  <InputTitle>{m.assignment_field_grades()}</InputTitle>
                  <GradesSelect className="w-37.5" control={control} />
                </div>
              )}
              {hasPolicy &&
                (kind === 'marked' || gradedAssignment) &&
                !noLate && (
                  <div className="flex min-h-8 items-center justify-between gap-4">
                    <InputTitle>{m.assignment_field_late_penalty()}</InputTitle>
                    <LatePenaltySelect className="w-37.5" control={control} />
                  </div>
                )}
              {hasDraft && (
                <SwitchRow
                  control={control}
                  label={m.assignment_switch_draft()}
                  name="draft"
                />
              )}
            </Accordion>
          )}
          {errors.root?.message && (
            <InputError>{errors.root.message}</InputError>
          )}
          <DialogFooter
            className={cn('max-sm:hidden sm:pt-2.5', graded && 'mt-auto')}
          >
            <DialogCancel disabled={saving} size="md" />
            {createButton}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
