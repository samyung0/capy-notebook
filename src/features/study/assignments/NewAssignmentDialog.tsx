import { zodResolver } from '@hookform/resolvers/zod';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { type Control, Controller, useForm } from 'react-hook-form';
import { CreateAssignmentBody } from '@/api/gen/validators';
import {
  useCreateAssignment,
  useFiles,
  useMaterials,
  useMe,
  usePractice,
  useUpdateAssignment,
  useWorkspaceMembers,
} from '@/api/hooks';
import type {
  Assignment,
  AssignmentFileRef,
  AssignmentFormReq,
  WorkspaceMember,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input, InputError } from '@/components/ui/Input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { PanelSearchField } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { questionsLabel } from '../practice/practiceText';
import { AdvancedSection } from './AdvancedSection';
import {
  advancedStartsOpen,
  dayLabel,
  dayTimeLabel,
  latePolicy,
  localInputValue,
  minutesText,
} from './assignmentText';
import { NoAnswersWarning } from './NoAnswersWarning';

const TIME_LIMITS = [15, 30, 45, 60, 90, 120, 180];
const ATTEMPTS = [1, 2, 3, 5];
const LATE_PENALTIES = [0, 20, 50];

const FIELD_TRIGGER =
  'flex h-(--control-h) w-full items-center gap-2 rounded-input border border-line bg-field px-3.25 text-left text-fg outline-none hover:border-line-strong focus-visible:border-line-strong data-[state=open]:border-line-strong';

/** New assignment and its edit (boards A1, A1b, A1c, A1d): Kind first, then a
 * quiz with its marks rules, or a title with optional files. Editing keeps the
 * kind and the quiz. `newQuiz` is the seam for making a quiz on the spot (New
 * quiz, Make a quiz from a file, Generate questions; A1c, A1e): without it those
 * rows show as Coming soon. */
export function NewAssignmentDialog({
  existing,
  newQuiz,
  onClose,
  onDone,
  presetQuizId,
  workspaceId,
}: {
  existing?: Assignment;
  newQuiz?: (how: 'blank' | 'file' | 'generate') => void;
  onClose: () => void;
  onDone: (assignment: Assignment) => void;
  /** Opened from a quiz (A1): its quiz is set and Kind doesn't show. */
  presetQuizId?: string;
  workspaceId: string;
}) {
  const manage = existing?.manage;
  const formId = useId();
  const { data: practice } = usePractice(workspaceId, { errorBoundary: false });
  const { data: members } = useWorkspaceMembers(workspaceId);
  const quizzes = practice?.quizzes ?? [];
  const {
    control,
    formState: { errors },
    handleSubmit,
    setError,
    setValue,
    watch,
  } = useForm<AssignmentFormReq>({
    defaultValues: {
      approveAiMarks: manage?.approveAiMarks ?? true,
      assignAll: manage?.assignAll ?? true,
      assignees: manage?.assignees ?? [],
      attempts: existing?.attempts ?? 1,
      draft: existing?.draft ?? false,
      dueAt: existing?.dueAt,
      files: (existing?.files ?? []).map(({ fileId, materialId }) => ({
        fileId,
        materialId,
      })),
      kind: existing?.kind ?? 'marked',
      latePenaltyPct: existing?.latePenaltyPct ?? 0,
      noLate: existing?.noLate ?? false,
      quizId: manage?.quizId ?? presetQuizId,
      showAnswers: manage?.showAnswers ?? true,
      shuffle: manage?.shuffle ?? false,
      timeLimitMin: existing?.timeLimitMin,
      title:
        existing?.title ??
        quizzes.find((q) => q.id === presetQuizId)?.title ??
        '',
    },
    mode: 'onSubmit',
    resolver: zodResolver(
      CreateAssignmentBody.superRefine((v, ctx) => {
        if (!v.title.trim())
          ctx.addIssue({
            code: 'custom',
            message: m.assignment_title_required(),
            path: ['title'],
          });
        if (v.kind !== 'marked') return;
        if (!v.quizId)
          ctx.addIssue({
            code: 'custom',
            message: m.assignment_quiz_required(),
            path: ['quizId'],
          });
        if (!v.draft && !v.dueAt)
          ctx.addIssue({
            code: 'custom',
            message: m.assignment_due_required(),
            path: ['dueAt'],
          });
      })
    ),
  });
  const kind = watch('kind');
  const quizId = watch('quizId');
  const dueAt = watch('dueAt');
  const noLate = watch('noLate');
  const attempts = watch('attempts');
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    advancedStartsOpen(existing)
  );
  // The policy goes with a marked assignment's due date; a published one is past
  // being a draft.
  const hasPolicy = kind === 'marked' && !!dueAt;
  const hasDraft = !existing || existing.draft;
  const [titleEdited, setTitleEdited] = useState(!!existing);
  const { mutate: create, isPending: creating } =
    useCreateAssignment(workspaceId);
  const { mutate: update, isPending: updating } = useUpdateAssignment(
    workspaceId,
    existing?.id ?? ''
  );
  const saving = creating || updating;
  // Opened from a quiz before the list arrived: its name becomes the title.
  const presetTitle = quizzes.find((q) => q.id === presetQuizId)?.title;
  useEffect(() => {
    if (presetTitle && !titleEdited) setValue('title', presetTitle);
  }, [presetTitle, setValue, titleEdited]);
  const submit = handleSubmit((values) => {
    const body: AssignmentFormReq = {
      ...values,
      ...latePolicy(values),
      // Someone who left after this assignment was read can't be assigned.
      assignees: values.assignees?.filter(
        (id) => !members || members.some((member) => member.userId === id)
      ),
      files: kind === 'marked' ? [] : values.files,
      quizId: kind === 'marked' ? values.quizId : undefined,
      timeLimitMin: kind === 'marked' ? values.timeLimitMin : undefined,
      title: values.title.trim(),
    };
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
  const locked = !!existing || !!presetQuizId;
  const quiz = quizzes.find((q) => q.id === quizId);
  // In the phone header and the form's footer: either one, or Enter in a field,
  // submits the form once.
  const createButton = (
    <Button disabled={saving} form={formId} type="submit">
      {existing ? m.action_save() : m.assignment_create()}
    </Button>
  );

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        aria-describedby={undefined}
        cardScrollContainerClassName="sm:px-6.25"
        className="sm:max-w-150"
        showCloseButton={false}
      >
        <DialogTitle action={createButton}>
          {existing ? m.assignment_edit() : m.assignment_new()}
        </DialogTitle>
        <form
          className="flex flex-col gap-4 pt-1"
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!saving) void submit();
          }}
        >
          {!locked && (
            <Field label={m.assignment_field_kind()}>
              <Controller
                control={control}
                name="kind"
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger aria-label={m.assignment_field_kind()}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="marked">
                        {m.assignment_kind_marked()}
                      </SelectItem>
                      <SelectItem value="unmarked">
                        {m.assignment_kind_unmarked()}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          )}
          {kind === 'marked' &&
            (locked ? (
              <Field label={m.assignment_field_quiz()}>
                <div className="flex min-h-7 items-center gap-2">
                  <FileIcon
                    className="size-4 shrink-0"
                    name={materialIconName('quiz')}
                  />
                  <span className="truncate font-semibold">
                    {quiz?.title ?? manage?.quizTitle}
                  </span>
                  {quiz && (
                    <span className="t-meta shrink-0 text-fg-muted">
                      {questionsLabel(quiz.questions)}
                    </span>
                  )}
                </div>
              </Field>
            ) : (
              <Field
                error={errors.quizId?.message}
                label={m.assignment_field_quiz()}
              >
                <QuizPicker
                  newQuiz={newQuiz}
                  onPick={(id, title) => {
                    setValue('quizId', id, { shouldValidate: true });
                    if (!titleEdited) setValue('title', title);
                  }}
                  quizzes={quizzes}
                  value={quizId}
                />
                {quizId && <NoAnswersWarning quizId={quizId} />}
              </Field>
            ))}
          <Field
            error={errors.title?.message}
            label={m.assignment_field_title()}
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
                  onChange={(event) => {
                    setTitleEdited(true);
                    field.onChange(event);
                  }}
                />
              )}
            />
          </Field>
          {kind === 'unmarked' && (
            <Field
              hint={m.assignment_optional()}
              label={m.assignment_field_files()}
            >
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              error={errors.dueAt?.message}
              label={m.assignment_field_due()}
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
                <Controller
                  control={control}
                  name="timeLimitMin"
                  render={({ field }) => (
                    <Select
                      onValueChange={(value) =>
                        field.onChange(
                          value === 'none' ? undefined : Number(value)
                        )
                      }
                      value={field.value ? String(field.value) : 'none'}
                    >
                      <SelectTrigger
                        aria-label={m.assignment_field_time_limit()}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          {m.assignment_no_limit()}
                        </SelectItem>
                        {TIME_LIMITS.map((min) => (
                          <SelectItem key={min} value={String(min)}>
                            {minutesText(min)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            ) : (
              <AssignToField control={control} workspaceId={workspaceId} />
            )}
            {kind === 'marked' && (
              <>
                <Field label={m.assignment_field_attempts()}>
                  <Controller
                    control={control}
                    name="attempts"
                    render={({ field }) => (
                      <Select
                        onValueChange={(value) => field.onChange(Number(value))}
                        value={String(field.value)}
                      >
                        <SelectTrigger
                          aria-label={m.assignment_field_attempts()}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ATTEMPTS.map((count) => (
                            <SelectItem key={count} value={String(count)}>
                              {count}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {attempts > 1 && (
                    <span className="t-meta text-fg-muted">
                      {m.assignment_highest_counts()}
                    </span>
                  )}
                </Field>
                <AssignToField control={control} workspaceId={workspaceId} />
              </>
            )}
          </div>
          {kind === 'marked' && (
            <div className="flex flex-col gap-2 pt-0.5">
              <SwitchRow
                control={control}
                label={m.assignment_switch_approve()}
                name="approveAiMarks"
              />
              <SwitchRow
                control={control}
                label={m.assignment_switch_answers()}
                name="showAnswers"
              />
              <SwitchRow
                control={control}
                label={m.assignment_switch_shuffle()}
                name="shuffle"
              />
            </div>
          )}
          {(hasPolicy || hasDraft) && (
            <AdvancedSection
              onToggle={() => setAdvancedOpen(!advancedOpen)}
              open={advancedOpen}
            >
              {hasPolicy && (
                <SwitchRow
                  control={control}
                  label={m.assignment_switch_no_late()}
                  name="noLate"
                />
              )}
              {hasPolicy && !noLate && (
                <div className="flex min-h-8 items-center justify-between gap-4">
                  <span className="font-medium">
                    {m.assignment_field_late_penalty()}
                  </span>
                  <Controller
                    control={control}
                    name="latePenaltyPct"
                    render={({ field }) => (
                      <Select
                        onValueChange={(value) => field.onChange(Number(value))}
                        value={String(field.value)}
                      >
                        <SelectTrigger
                          aria-label={m.assignment_field_late_penalty()}
                          className="w-37.5"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LATE_PENALTIES.map((pct) => (
                            <SelectItem key={pct} value={String(pct)}>
                              {pct === 0
                                ? m.assignment_penalty_none()
                                : m.assignment_penalty_value({ percent: pct })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
              )}
              {hasDraft && (
                <SwitchRow
                  control={control}
                  label={m.assignment_switch_draft()}
                  name="draft"
                />
              )}
            </AdvancedSection>
          )}
          {errors.root?.message && (
            <InputError>{errors.root.message}</InputError>
          )}
          <DialogFooter className="max-sm:hidden sm:pt-2.5">
            <Button
              disabled={saving}
              onClick={onClose}
              type="button"
              variant="ghost"
            >
              {m.action_cancel()}
            </Button>
            {createButton}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  children,
  error,
  hint,
  label,
}: {
  children: ReactNode;
  error?: string;
  hint?: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.75">
      <span className="font-medium text-[13.5px] leading-tight">
        {label}
        {hint && <span className="text-fg-muted"> · {hint}</span>}
      </span>
      {children}
      {error && <InputError>{error}</InputError>}
    </div>
  );
}

function SwitchRow({
  control,
  label,
  name,
}: {
  control: Control<AssignmentFormReq>;
  label: string;
  name: 'draft' | 'approveAiMarks' | 'noLate' | 'showAnswers' | 'shuffle';
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div className="flex min-h-8 items-center justify-between gap-4">
          <span className="font-medium">{label}</span>
          <Switch
            aria-label={label}
            checked={!!field.value}
            className="data-checked:bg-solid-accent-1"
            onCheckedChange={field.onChange}
          />
        </div>
      )}
    />
  );
}

/** A due date: the board's field, opening the browser's own picker. */
function DateField({
  clearable,
  dateOnly,
  onChange,
  value,
}: {
  clearable: boolean;
  dateOnly: boolean;
  onChange: (value: string | undefined) => void;
  value?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <button
        className={FIELD_TRIGGER}
        onClick={() => {
          const el = input.current;
          if (!el) return;
          if (el.showPicker) el.showPicker();
          else el.focus();
        }}
        type="button"
      >
        <Icon className="shrink-0 text-fg-muted" name="schedule" size={16} />
        <span className={cn('truncate', !value && 'text-placeholder')}>
          {value
            ? dateOnly
              ? dayLabel(value)
              : dayTimeLabel(value)
            : m.assignment_choose_date()}
        </span>
      </button>
      {clearable && value && (
        <IconButton
          className="absolute top-1/2 right-1.5 size-7 -translate-y-1/2"
          icon="x"
          label={m.assignment_clear_due()}
          onClick={() => onChange(undefined)}
          type="button"
        />
      )}
      <input
        aria-label={m.assignment_field_due()}
        className="pointer-events-none absolute inset-0 opacity-0"
        data-due-input
        onChange={(event) => {
          const raw = event.target.value;
          if (!raw) return onChange(undefined);
          // A date alone means the end of that day.
          onChange(new Date(dateOnly ? `${raw}T23:59` : raw).toISOString());
        }}
        ref={input}
        tabIndex={-1}
        type={dateOnly ? 'date' : 'datetime-local'}
        value={value ? localInputValue(value, dateOnly) : ''}
      />
    </div>
  );
}

/** The quiz field (A1c): the workspace's quizzes, then the ways to make one. */
function QuizPicker({
  newQuiz,
  onPick,
  quizzes,
  value,
}: {
  newQuiz?: (how: 'blank' | 'file' | 'generate') => void;
  onPick: (id: string, title: string) => void;
  quizzes: { id: string; title: string; questions: number }[];
  value?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const picked = quizzes.find((q) => q.id === value);
  const shown = quizzes.filter((q) =>
    q.title.toLowerCase().includes(query.trim().toLowerCase())
  );
  const makers: {
    how: 'blank' | 'file' | 'generate';
    icon: 'plus' | 'upload' | 'ai';
    label: string;
  }[] = [
    { how: 'blank', icon: 'plus', label: m.assignment_new_quiz() },
    { how: 'file', icon: 'upload', label: m.dashboard_make_quiz() },
    { how: 'generate', icon: 'ai', label: m.assignment_generate_questions() },
  ];
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={m.assignment_field_quiz()}
          className={FIELD_TRIGGER}
          type="button"
        >
          {picked && (
            <FileIcon
              className="size-4 shrink-0"
              name={materialIconName('quiz')}
            />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              !picked && 'text-placeholder'
            )}
          >
            {picked?.title ?? m.assignment_choose_quiz()}
          </span>
          <Icon
            className="shrink-0 text-fg-muted"
            name="chevronDown"
            size={16}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-1.5"
      >
        <PanelSearchField
          label={m.assignment_search_quizzes()}
          onChange={setQuery}
          value={query}
        />
        <ul className="mt-1.5 max-h-60 overflow-auto">
          {shown.map((q) => (
            <li key={q.id}>
              <button
                className="flex min-h-9 w-full items-center gap-2.5 rounded-button px-2.5 text-left font-semibold outline-none hover:bg-overlay-hover focus-visible:bg-overlay-hover"
                onClick={() => {
                  onPick(q.id, q.title);
                  setOpen(false);
                }}
                type="button"
              >
                <FileIcon
                  className="size-4 shrink-0"
                  name={materialIconName('quiz')}
                />
                <span className="min-w-0 flex-1 truncate">{q.title}</span>
                <span className="t-meta shrink-0 font-medium text-fg-muted">
                  {questionsLabel(q.questions)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-1.5 border-divider border-t pt-1.5">
          {makers.map(({ how, icon, label }) => (
            <button
              className={cn(
                'flex min-h-9 w-full items-center gap-2.5 rounded-button px-2.5 text-left font-semibold outline-none',
                newQuiz
                  ? 'hover:bg-overlay-hover focus-visible:bg-overlay-hover'
                  : 'cursor-default text-fg-muted'
              )}
              key={how}
              onClick={() => newQuiz?.(how)}
              title={newQuiz ? undefined : m.study_panel_soon()}
              type="button"
            >
              <Icon className="shrink-0" name={icon} size={16} />
              {label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Assign to (A1b): All members, or picked names; "You" sits apart. */
function AssignToField({
  control,
  workspaceId,
}: {
  control: Control<AssignmentFormReq>;
  workspaceId: string;
}) {
  const { data: members } = useWorkspaceMembers(workspaceId);
  const { data: user } = useMe();
  const viewers = (members ?? []).filter(
    (member) => member.role === 'viewer' && member.userId !== user?.id
  );
  const me = (members ?? []).find((member) => member.userId === user?.id);
  return (
    <Field label={m.assignment_field_assign_to()}>
      <Controller
        control={control}
        name="assignAll"
        render={({ field: all }) => (
          <Controller
            control={control}
            name="assignees"
            render={({ field: named }) => {
              const picked: string[] = named.value ?? [];
              const pickedViewers = viewers.filter((v) =>
                picked.includes(v.userId)
              ).length;
              const toggle = (id: string) => {
                if (all.value) {
                  // Unticking one of everyone leaves the rest named.
                  all.onChange(false);
                  named.onChange([
                    ...picked,
                    ...viewers
                      .map((v) => v.userId)
                      .filter((v) => v !== id && !picked.includes(v)),
                  ]);
                  return;
                }
                named.onChange(
                  picked.includes(id)
                    ? picked.filter((v) => v !== id)
                    : [...picked, id]
                );
              };
              const toggleAll = () => {
                all.onChange(!all.value);
                named.onChange(picked.filter((id) => id === user?.id));
              };
              return (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      aria-label={m.assignment_field_assign_to()}
                      className={FIELD_TRIGGER}
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {all.value
                          ? m.assignment_all_members()
                          : pickedViewers === 1
                            ? m.workspace_members_one()
                            : m.workspace_members_count({
                                count: pickedViewers,
                              })}
                      </span>
                      <Icon
                        className="shrink-0 text-fg-muted"
                        name="chevronDown"
                        size={16}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-85 max-w-[calc(100vw-2rem)] p-1.5"
                  >
                    <PersonRow
                      checked={!!all.value}
                      label={m.assignment_all_members()}
                      onToggle={toggleAll}
                      trailing={m.assignment_all_members_hint({
                        count: viewers.length,
                      })}
                    />
                    <div className="my-1 max-h-60 overflow-auto border-divider border-y py-1">
                      {viewers.map((viewer) => (
                        <PersonRow
                          checked={
                            !!all.value || picked.includes(viewer.userId)
                          }
                          key={viewer.userId}
                          label={viewer.name}
                          member={viewer}
                          onToggle={() => toggle(viewer.userId)}
                        />
                      ))}
                    </div>
                    {me && (
                      <PersonRow
                        checked={picked.includes(me.userId)}
                        label={m.assignment_you()}
                        member={me}
                        onToggle={() =>
                          named.onChange(
                            picked.includes(me.userId)
                              ? picked.filter((v) => v !== me.userId)
                              : [...picked, me.userId]
                          )
                        }
                        trailing={
                          me.role === 'owner'
                            ? m.assignment_role_owner()
                            : m.assignment_role_ta()
                        }
                      />
                    )}
                  </PopoverContent>
                </Popover>
              );
            }}
          />
        )}
      />
    </Field>
  );
}

function PersonRow({
  checked,
  label,
  member,
  onToggle,
  trailing,
}: {
  checked: boolean;
  label: string;
  member?: Pick<WorkspaceMember, 'name' | 'avatarUrl'>;
  onToggle: () => void;
  trailing?: string;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-1.5 font-semibold">
      <Checkbox
        aria-label={label}
        checked={checked}
        onChange={onToggle}
        size={18}
        tone="purple"
      />
      {member && (
        <Avatar
          aria-hidden
          className="size-6 text-[10px]"
          name={member.name}
          src={member.avatarUrl || undefined}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing && (
        <span className="t-meta shrink-0 font-medium text-fg-muted">
          {trailing}
        </span>
      )}
    </div>
  );
}

/** Files · optional (A1d): rows with ×, and Add a file picking from Files. */
function FilesField({
  onChange,
  value,
  workspaceId,
}: {
  onChange: (files: AssignmentFileRef[]) => void;
  value: AssignmentFileRef[];
  workspaceId: string;
}) {
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const options = [
    ...(files ?? []).map((f) => ({
      icon: fileIconName(f),
      id: f.id,
      name: f.name,
      ref: { fileId: f.id } as AssignmentFileRef,
    })),
    ...(materials ?? []).map((mt) => ({
      icon: materialIconName(mt.type),
      id: mt.id,
      name: mt.title,
      ref: { materialId: mt.id } as AssignmentFileRef,
    })),
  ];
  const held = (id: string) =>
    value.some((f) => f.fileId === id || f.materialId === id);
  const picked = value.flatMap((f) => {
    const option = options.find((o) => o.id === (f.fileId ?? f.materialId));
    return option ? [option] : [];
  });
  const shown = options.filter(
    (o) =>
      !held(o.id) && o.name.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    <div className="flex flex-col items-start gap-2">
      {picked.length > 0 && (
        <ul className="w-full">
          {picked.map((o) => (
            <li
              className="flex min-h-9.5 items-center gap-2.5 border-divider border-b"
              key={o.id}
            >
              <FileIcon className="size-4 shrink-0" name={o.icon} />
              <span className="min-w-0 flex-1 truncate font-semibold">
                {o.name}
              </span>
              <IconButton
                className="size-7"
                icon="x"
                label={m.action_remove()}
                onClick={() =>
                  onChange(
                    value.filter(
                      (f) => f.fileId !== o.id && f.materialId !== o.id
                    )
                  )
                }
                type="button"
              />
            </li>
          ))}
        </ul>
      )}
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button iconLeft="plus" size="sm" type="button" variant="outline">
            {m.assignment_add_file()}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-85 max-w-[calc(100vw-2rem)] p-1.5"
        >
          <PanelSearchField
            label={m.assignment_search_files()}
            onChange={setQuery}
            value={query}
          />
          <ul className="mt-1.5 max-h-60 overflow-auto">
            {shown.map((o) => (
              <li key={o.id}>
                <button
                  className="flex min-h-9 w-full items-center gap-2.5 rounded-button px-2.5 text-left font-semibold outline-none hover:bg-overlay-hover focus-visible:bg-overlay-hover"
                  onClick={() => {
                    onChange([...value, o.ref]);
                    setOpen(false);
                  }}
                  type="button"
                >
                  <FileIcon className="size-4 shrink-0" name={o.icon} />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
