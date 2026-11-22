import { type FormEvent, useId, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { createAssignmentBodyTitleMax } from '@/api/gen/validators';
import {
  useCreateAssignment,
  useUpdateAssignment,
  useWorkspaceMembers,
} from '@/api/hooks';
import type { Assignment, AssignmentFormReq } from '@/api/types';
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
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { materialIconName } from '@/lib/fileIcons';
import { questionsLabel } from '../practice/practiceText';
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
  QuizPointsField,
  SubmissionSelect,
  SwitchRow,
  TimeLimitSelect,
} from './assignmentFields';
import { advancedStartsOpen } from './assignmentText';
import type { GradedSource } from './gradedSource';

/** New assignment and its edit (boards A1, A1b, A1d; Task, Epo 2026-11-14): a
 * class's staff give out an Assignment, a title with optional files. Editing
 * keeps the kind and the quiz. Nobody sets one for themself (Epo 2026-11-21). */
export function NewAssignmentDialog({
  existing,
  onClose,
  onDone,
  presetAssignee,
  workspaceId,
}: {
  existing?: Assignment;
  onClose: () => void;
  onDone: (assignment: Assignment) => void;
  /** Opened from a member's profile (Q721): them as the only assignee. */
  presetAssignee?: string;
  workspaceId: string;
}) {
  const { button, fields, form, saving } = useAssignmentForm({
    existing,
    onDone,
    presetAssignee,
    workspaceId,
  });
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        cardScrollContainerClassName="sm:px-6.25"
        className="sm:max-w-150"
      >
        <DialogTitle action={button}>
          {existing ? m.assignment_edit() : m.assignment_new()}
        </DialogTitle>
        <form {...form} className="flex flex-col gap-4 pt-1">
          {fields}
          <DialogFooter className="max-sm:hidden sm:pt-2.5">
            <DialogCancel disabled={saving} size="md" />
            {button}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A pick's name as a title, cut by characters so an emoji stays whole. */
const titleOf = (source: GradedSource) =>
  Array.from(source.name).slice(0, createAssignmentBodyTitleMax).join('');

/** The assignment form's fields and its submit button, which may sit anywhere
 * (`form` goes on the form holding the fields). New graded quiz's Settings,
 * its last step (`graded`, Epo 2026-11-20: after the questions, as what they
 * are decides some settings), starts on its pick's name and Create sends the
 * pick with the settings: a file is marked by hand out of the Points typed and
 * answered by upload, so Marking and Submission show that, locked; a quiz's
 * Points are its questions' marks, fixed. */
export function useAssignmentForm({
  existing,
  graded,
  onDone,
  presetAssignee,
  workspaceId,
}: {
  existing?: Assignment;
  graded?: boolean;
  /** Saved; not for a graded quiz, whose pick makes it. */
  onDone?: (assignment: Assignment) => void;
  presetAssignee?: string;
  workspaceId: string;
}) {
  const manage = existing?.manage;
  const formId = useId();
  const { data: members } = useWorkspaceMembers(workspaceId);
  const {
    clearErrors,
    control,
    formState: { errors },
    getValues,
    handleSubmit,
    setError,
    setValue,
    watch,
  } = useForm<AssignmentFormReq>({
    defaultValues: assignmentDefaults(
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
  // New graded quiz's pick, and what Marking and Submission were before a
  // file locked them.
  const [source, setSource] = useState<GradedSource>();
  const file = !!source?.file;
  const quizId = source?.quizId;
  const beforeFile = useRef<Partial<AssignmentFormReq>>({});
  // Draft only before a pick whose questions are read first held it on.
  const beforeDraft = useRef(false);
  const prefilled = useRef('');
  const [sending, setSending] = useState(false);
  const kind = watch('kind');
  const dueAt = watch('dueAt');
  const noLate = watch('noLate');
  const attempts = watch('attempts');
  const draft = watch('draft');
  // An Assignment taking uploads may be graded on points (Epo 2026-11-14;
  // only with uploads, 2026-11-21: with nothing handed in there is nothing to
  // grade), which brings Show grades and the late penalty.
  const takesPoints = kind === 'unmarked' && watch('allowUploads');
  const gradedAssignment = takesPoints && watch('points') !== undefined;
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      advancedStartsOpen(existing) ||
      !!manage?.shuffle ||
      (existing?.kind === 'unmarked' && manage?.showGrades === 'manual')
  );
  // No late submissions goes with a due date on either kind (Epo 2026-11-09),
  // the penalty with a marked one's marks; a published one is past being a
  // draft, an assignment kept from its members until published.
  const hasPolicy = !!dueAt;
  const hasDraft = !existing || existing.draft;
  const { mutate: create, isPending: creating } =
    useCreateAssignment(workspaceId);
  const { mutate: update, isPending: updating } = useUpdateAssignment(
    workspaceId,
    existing?.id ?? ''
  );
  const saving = creating || updating || sending;
  /** The first step's pick: Title follows it until one is typed. */
  const pick = (next: GradedSource) => {
    const name = titleOf(next);
    if (getValues('title') === prefilled.current) {
      setValue('title', name);
      prefilled.current = name;
    }
    if (!!next.file !== file) {
      if (next.file) {
        const { allowUploads, marking, uploadOnly } = getValues();
        beforeFile.current = { allowUploads, marking, uploadOnly };
        setValue('marking', 'manual');
        setValue('allowUploads', true);
        setValue('uploadOnly', true);
      } else {
        for (const [key, value] of Object.entries(beforeFile.current))
          setValue(key as keyof AssignmentFormReq, value);
        setValue('totalMarks', undefined);
      }
    }
    // Questions made or read for it are read before it goes out: Draft only
    // shows on, and held (Epo 2026-11-21).
    if (!!next.draft !== !!source?.draft) {
      if (next.draft) {
        beforeDraft.current = getValues('draft');
        setValue('draft', true);
      } else setValue('draft', beforeDraft.current);
    }
    clearErrors();
    setSource(next);
  };
  const submit = handleSubmit((values) => {
    const body = assignmentBody(values, members);
    if (graded) {
      if (!source) return;
      if (file && body.totalMarks === undefined) {
        setError('totalMarks', { message: m.assignment_total_required() });
        return;
      }
      setSending(true);
      source
        .send({
          ...body,
          // AI-made, read or blank questions are read before they go out.
          draft: body.draft || !!source.draft,
          title: body.title || titleOf(source),
          totalMarks: file ? body.totalMarks : undefined,
        })
        .catch((error: unknown) =>
          setError('root', {
            message: errorCopy(error, m.assignment_save_failed()),
          })
        )
        .finally(() => setSending(false));
      return;
    }
    const options = {
      onError: (error: unknown) =>
        setError('root', {
          message: errorCopy(error, m.assignment_save_failed()),
        }),
      onSuccess: (saved: Assignment) => onDone?.(saved),
    };
    if (existing) update(body, options);
    else create(body, options);
  });
  // In the phone header and the form's footer: either one, or Enter in a field,
  // submits the form once.
  const button = (
    <Button
      disabled={saving || (graded && !source)}
      form={formId}
      type="submit"
      variant="accent"
    >
      {/* As Draft only says (Epo 2026-11-21). */}
      {graded && sending
        ? (source?.busyLabel ?? <Spinner />)
        : existing
          ? m.action_save()
          : draft
            ? m.assignment_create_draft()
            : m.assignment_create()}
    </Button>
  );
  const form = {
    id: formId,
    noValidate: true,
    onSubmit: (event: FormEvent) => {
      event.preventDefault();
      if (!saving) void submit();
    },
  };

  const fields = (
    <>
      {!graded && kind === 'marked' && (
        <Field label={m.assignment_field_quiz()}>
          <div className="flex min-h-7 items-center gap-2">
            <FileIcon
              className="size-4 shrink-0"
              name={materialIconName('quiz')}
            />
            <span className="truncate font-semibold">{manage?.quizTitle}</span>
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
              placeholder={graded ? m.assignment_title_from_quiz() : undefined}
            />
          )}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
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
          <AssignToField control={control} workspaceId={workspaceId} />
        )}
        {/* Attempts is in Advanced (Epo 2026-11-21). */}
        {kind === 'marked' && (
          <div className="sm:col-span-2">
            <AssignToField control={control} workspaceId={workspaceId} />
          </div>
        )}
      </div>
      {/* C2 (Epo 2026-11-08): Files below Due and Assign to, then the switch:
          members hand in files with Hand in, graded out of the Points under
          it, as a graded quiz's sit with its Submission (Epo 2026-11-21). */}
      {kind === 'unmarked' && (
        <>
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
          <SwitchRow
            control={control}
            label={m.assignment_switch_uploads()}
            name="allowUploads"
          />
          {takesPoints && (
            <div className="grid gap-4 sm:grid-cols-2">
              <PointsField
                control={control}
                error={errors.points?.message}
                label={m.assignment_field_points()}
                name="points"
              />
            </div>
          )}
        </>
      )}
      {kind === 'marked' && (
        <div className="flex flex-col gap-2 pt-0.5">
          {/* Marking (A4, Epo 2026-11-06), then Submission; when
                  members see grades and keys (C4, C3) is in Advanced (Epo
                  2026-11-20). */}
          <div className="mb-1 grid gap-4 sm:grid-cols-2">
            {/* Points beside Marking (Epo 2026-11-20): typed for a file,
                    which is marked by hand; a quiz's own, fixed. */}
            <div className={cn(!(file || quizId) && 'sm:col-span-2')}>
              <Field label={m.assignment_field_marking()}>
                <MarkingSelect control={control} disabled={file} />
              </Field>
            </div>
            {file && (
              <PointsField
                control={control}
                error={errors.totalMarks?.message}
                label={m.assignment_field_points()}
                name="totalMarks"
              />
            )}
            {quizId && <QuizPointsField quizId={quizId} />}
            {/* C1 (Epo 2026-11-08), as a mode (Epo 2026-11-19). */}
            <div className="sm:col-span-2">
              <Field label={m.assignment_field_submission()}>
                <SubmissionSelect control={control} disabled={file} />
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
            <>
              <div className="flex flex-col gap-1">
                <div className="flex min-h-8 items-center justify-between gap-4">
                  <InputTitle>{m.assignment_field_attempts()}</InputTitle>
                  <AttemptsSelect control={control} layout="row" />
                </div>
                {attempts > 1 && (
                  <span className="t-meta text-fg-muted">
                    {m.assignment_highest_counts()}
                  </span>
                )}
              </div>
              <div className="flex min-h-8 items-center justify-between gap-4">
                <InputTitle>{m.assignment_field_grades()}</InputTitle>
                <GradesSelect control={control} layout="row" />
              </div>
              <div className="flex min-h-8 items-center justify-between gap-4">
                <InputTitle>{m.assignment_field_answers()}</InputTitle>
                <AnswersSelect control={control} layout="row" />
              </div>
              <SwitchRow
                control={control}
                label={m.assignment_switch_shuffle()}
                name="shuffle"
              />
            </>
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
              <GradesSelect control={control} layout="row" />
            </div>
          )}
          {hasPolicy && (kind === 'marked' || gradedAssignment) && !noLate && (
            <div className="flex min-h-8 items-center justify-between gap-4">
              <InputTitle>{m.assignment_field_late_penalty()}</InputTitle>
              <LatePenaltySelect control={control} layout="row" />
            </div>
          )}
          {hasDraft && (
            <SwitchRow
              control={control}
              disabled={!!source?.draft}
              label={m.assignment_switch_draft()}
              name="draft"
            />
          )}
        </Accordion>
      )}
      {errors.root?.message && <InputError>{errors.root.message}</InputError>}
    </>
  );
  return { button, fields, form, pick, saving };
}
