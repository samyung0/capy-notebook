import { zodResolver } from '@hookform/resolvers/zod';
import { type ReactNode, useRef, useState } from 'react';
import { type Control, Controller } from 'react-hook-form';
import {
  CreateAssignmentBody,
  createAssignmentBodyFilesMax,
} from '@/api/gen/validators';
import {
  useFiles,
  useMaterials,
  useMe,
  useWorkspaceMembers,
} from '@/api/hooks';
import type {
  Assignment,
  AssignmentFileRef,
  AssignmentFormReq,
  WorkspaceMember,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Checkbox } from '@/components/ui/Checkbox';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
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
import {
  ChooseFileButton,
  FileMenuNote,
  FileMenuRow,
  FileSearchMenu,
  RemoveFileButton,
} from '@/features/files/FileSearchMenu';
import { matchesSearch } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import {
  dayLabel,
  dayTimeLabel,
  isGraded,
  latePolicy,
  localInputValue,
  minutesText,
} from './assignmentText';
import { ChooseFileRow } from './TaskFiles';

const TIME_LIMITS = [15, 30, 45, 60, 90, 120, 180];
const ATTEMPTS = [1, 2, 3, 5];
const LATE_PENALTIES = [0, 20, 50];
const WHOLE_NUMBER = /^\d+$/;

export const FIELD_TRIGGER =
  'flex h-(--control-h) w-full items-center gap-2 rounded-input border border-line bg-field px-3.25 text-left text-fg outline-none hover:border-line-strong focus-visible:border-line-strong data-[state=open]:border-line-strong';

/** A field under its name; one that must be filled has the red asterisk, as
 * the workspace settings' Name does (Epo 2026-11-12). */
export function Field({
  children,
  error,
  label,
  required,
}: {
  children: ReactNode;
  error?: string;
  label: string;
  required?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <InputTitle required={required}>{label}</InputTitle>
      {children}
      {error && <InputError>{error}</InputError>}
    </div>
  );
}

export function SwitchRow({
  control,
  label,
  name,
}: {
  control: Control<AssignmentFormReq>;
  label: string;
  name: 'allowUploads' | 'draft' | 'noLate' | 'shuffle';
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div className="flex min-h-8 items-center justify-between gap-4">
          <InputTitle>{label}</InputTitle>
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
export function DateField({
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

/** Assign to (A1b): All members, or picked names; "You" sits apart. */
export function AssignToField({
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
                    {/* One line with nobody to list: a second would sit right under it. */}
                    <div
                      className={cn(
                        'my-1 max-h-60 overflow-auto border-divider border-t',
                        viewers.length > 0 && 'border-b py-1'
                      )}
                    >
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

/** Files · optional (A1d): Choose a file picking from the workspace's Files,
 * kept above the rows chosen, each with × (Epo 2026-11-12: Make a quiz's
 * menu, the chosen ones ticked there; a ticked row takes its file off, and the
 * menu stays open for more). */
export function FilesField({
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
  const remove = (id: string) =>
    onChange(value.filter((f) => f.fileId !== id && f.materialId !== id));
  const full = value.length >= createAssignmentBodyFilesMax;
  const picked = value.flatMap((f) => {
    const option = options.find((o) => o.id === (f.fileId ?? f.materialId));
    return option ? [option] : [];
  });
  return (
    <div className="flex flex-col gap-2">
      <ChooseFileRow count={value.length}>
        <FileSearchMenu
          label={m.assignment_search_files()}
          onOpenChange={setOpen}
          open={open}
          searchLabel={m.assignment_search_files()}
          trigger={<ChooseFileButton />}
        >
          {(query) => {
            const shown = options.filter((o) => matchesSearch(o.name, query));
            return (
              <>
                {shown.map((o) => (
                  <FileMenuRow
                    className="disabled:cursor-default"
                    disabled={full && !held(o.id)}
                    key={o.id}
                    onClick={() =>
                      held(o.id) ? remove(o.id) : onChange([...value, o.ref])
                    }
                    role="option"
                    selected={held(o.id)}
                  >
                    <FileIcon className="size-4 shrink-0" name={o.icon} />
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  </FileMenuRow>
                ))}
                {shown.length === 0 && (
                  <FileMenuNote>{m.common_no_matches()}</FileMenuNote>
                )}
              </>
            );
          }}
        </FileSearchMenu>
      </ChooseFileRow>
      {picked.length > 0 && (
        <ul className="w-full">
          {picked.map((o) => (
            <li className="flex min-h-8 items-center gap-2.5 pl-2" key={o.id}>
              <FileIcon className="size-4 shrink-0" name={o.icon} />
              <span className="min-w-0 flex-1 truncate font-semibold">
                {o.name}
              </span>
              <RemoveFileButton
                label={m.action_remove()}
                onClick={() => remove(o.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The form's values for a saved assignment, or a new one's starting values. */
export function assignmentDefaults(
  existing: Assignment | undefined,
  start: Partial<AssignmentFormReq> = {}
): AssignmentFormReq {
  const manage = existing?.manage;
  return {
    allowUploads: existing?.allowUploads ?? false,
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
    marking: manage?.marking ?? 'ai_approve',
    noLate: existing?.noLate ?? false,
    points: existing?.points,
    quizId: manage?.quizId,
    showAnswers: manage?.showAnswers ?? 'closed',
    showGrades: manage?.showGrades ?? 'automatic',
    shuffle: manage?.shuffle ?? false,
    timeLimitMin: existing?.timeLimitMin,
    title: existing?.title ?? '',
    ...start,
  };
}

/** The form's rules beyond the API's: a title, and a marked one's due date
 * once published. */
export const assignmentResolver = zodResolver(
  CreateAssignmentBody.superRefine((v, ctx) => {
    if (!v.title.trim())
      ctx.addIssue({
        code: 'custom',
        message: m.assignment_title_required(),
        path: ['title'],
      });
    if (v.kind !== 'marked') return;
    if (!v.draft && !v.dueAt)
      ctx.addIssue({
        code: 'custom',
        message: m.assignment_due_required(),
        path: ['dueAt'],
      });
  })
);

/** What is sent for the form's values: each kind's own fields, a late policy
 * that fits its due date, and only assignees still in the class. */
export function assignmentBody(
  values: AssignmentFormReq,
  members: WorkspaceMember[] | undefined
): AssignmentFormReq {
  const marked = values.kind === 'marked';
  return {
    ...values,
    ...latePolicy(values),
    assignees: values.assignees?.filter(
      (id) => !members || members.some((member) => member.userId === id)
    ),
    files: marked ? [] : values.files,
    points: marked ? undefined : values.points,
    quizId: marked ? values.quizId : undefined,
    // Grades held for release need something graded.
    showGrades: isGraded(values) ? values.showGrades : 'automatic',
    timeLimitMin: marked ? values.timeLimitMin : undefined,
    title: values.title.trim(),
  };
}

type Controlled = { control: Control<AssignmentFormReq> };

/** A class's Assignment's Points (Epo 2026-11-14, board Task): empty is not
 * graded; staff then grade each member out of them. */
export function PointsField({
  control,
  error,
}: Controlled & { error?: string }) {
  return (
    <Field error={error} label={m.assignment_field_points()}>
      <Controller
        control={control}
        name="points"
        render={({ field, fieldState }) => (
          <Input
            aria-invalid={fieldState.invalid}
            aria-label={m.assignment_field_points()}
            autoComplete="off"
            inputMode="numeric"
            name={field.name}
            onBlur={field.onBlur}
            onChange={(event) => {
              // Whole points: anything else typed is left out.
              const value = event.target.value.trim();
              if (value === '') field.onChange(undefined);
              else if (WHOLE_NUMBER.test(value)) field.onChange(Number(value));
            }}
            ref={field.ref}
            value={field.value ?? ''}
          />
        )}
      />
    </Field>
  );
}

export function TimeLimitSelect({ control }: Controlled) {
  return (
    <Controller
      control={control}
      name="timeLimitMin"
      render={({ field }) => (
        <Select
          onValueChange={(value) =>
            field.onChange(value === 'none' ? undefined : Number(value))
          }
          value={field.value ? String(field.value) : 'none'}
        >
          <SelectTrigger aria-label={m.assignment_field_time_limit()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{m.assignment_no_limit()}</SelectItem>
            {TIME_LIMITS.map((min) => (
              <SelectItem key={min} value={String(min)}>
                {minutesText(min)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}

export function AttemptsSelect({ control }: Controlled) {
  return (
    <Controller
      control={control}
      name="attempts"
      render={({ field }) => (
        <Select
          onValueChange={(value) => field.onChange(Number(value))}
          value={String(field.value)}
        >
          <SelectTrigger aria-label={m.assignment_field_attempts()}>
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
  );
}

/** How answers are marked (A4, Epo 2026-11-06). */
export function MarkingSelect({ control }: Controlled) {
  return (
    <Controller
      control={control}
      name="marking"
      render={({ field }) => (
        <Select onValueChange={field.onChange} value={field.value}>
          <SelectTrigger aria-label={m.assignment_field_marking()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ai_approve">
              {m.assignment_marking_ai_approve()}
            </SelectItem>
            <SelectItem value="ai">{m.assignment_marking_ai()}</SelectItem>
            <SelectItem value="manual">
              {m.assignment_marking_manual()}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
    />
  );
}

/** When members see their grades (C4). */
export function GradesSelect({
  className,
  control,
}: Controlled & { className?: string }) {
  return (
    <Controller
      control={control}
      name="showGrades"
      render={({ field }) => (
        <Select onValueChange={field.onChange} value={field.value}>
          <SelectTrigger
            aria-label={m.assignment_field_grades()}
            className={className}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="automatic">
              {m.assignment_grades_automatic()}
            </SelectItem>
            <SelectItem value="manual">
              {m.assignment_grades_manual()}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
    />
  );
}

/** When members see the answers (C3). */
export function AnswersSelect({ control }: Controlled) {
  return (
    <Controller
      control={control}
      name="showAnswers"
      render={({ field }) => (
        <Select onValueChange={field.onChange} value={field.value}>
          <SelectTrigger aria-label={m.assignment_field_answers()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="closed">
              {m.assignment_answers_closed()}
            </SelectItem>
            <SelectItem value="submitted">
              {m.assignment_answers_submitted()}
            </SelectItem>
            <SelectItem value="never">
              {m.assignment_answers_never()}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
    />
  );
}

export function LatePenaltySelect({
  className,
  control,
}: Controlled & { className?: string }) {
  return (
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
            className={className}
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
  );
}
