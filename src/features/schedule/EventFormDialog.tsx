import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  CreateEventBody,
  createEventBodyLocationMax,
} from '@/api/gen/validators';
import type { Label } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';

export interface EventFormValues {
  end: string;
  labelIds: string[];
  location?: string;
  start: string;
  title: string;
}

export interface EventDraft {
  end?: string;
  // present when editing an existing event; absent when creating.
  id?: string;
  labelIds?: string[];
  location?: string;
  start?: string;
  title?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toDateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const combine = (dateStr: string, timeStr: string) =>
  new Date(`${dateStr}T${timeStr}`).toISOString();

function defaultStart() {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d;
}

const EventFormFieldsSchema = z.object({
  date: z.string().min(1),
  endTime: z.string().min(1),
  labelIds: z.array(z.string()),
  location: z.string().max(createEventBodyLocationMax),
  startTime: z.string().min(1),
  title: CreateEventBody.shape.title,
});

type EventFormFields = z.infer<typeof EventFormFieldsSchema>;

function eventFormSchema() {
  return EventFormFieldsSchema.refine((v) => v.endTime > v.startTime, {
    message: m.schedule_end_after_start(),
    path: ['endTime'],
  });
}

export function EventFormDialog({
  open,
  onClose,
  labels,
  draft,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  labels: Label[];
  draft?: EventDraft;
  onSubmit: (v: EventFormValues) => Promise<unknown> | unknown;
}) {
  const isEdit = !!draft?.id;
  const start = draft?.start ? new Date(draft.start) : defaultStart();
  const end = draft?.end
    ? new Date(draft.end)
    : new Date(start.getTime() + 60 * 60 * 1000);

  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
    watch,
    setValue,
  } = useForm<EventFormFields>({
    defaultValues: {
      date: toDateValue(start),
      endTime: toTimeValue(end),
      labelIds: draft?.labelIds ?? [],
      location: draft?.location ?? '',
      startTime: toTimeValue(start),
      title: draft?.title ?? '',
    },
    mode: 'onChange',
    resolver: zodResolver(eventFormSchema()),
  });

  const labelIds = watch('labelIds');
  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const toggleLabel = (id: string) => {
    const next = labelIds.includes(id)
      ? labelIds.filter((x) => x !== id)
      : [...labelIds, id];
    setValue('labelIds', next, { shouldDirty: true, shouldValidate: true });
  };

  const handleSubmit = useCallback(
    async (v: EventFormFields) => {
      try {
        await onSubmit({
          end: combine(v.date, v.endTime),
          labelIds: v.labelIds,
          location: v.location.trim() || undefined,
          start: combine(v.date, v.startTime),
          title: v.title.trim(),
        });
        onClose();
      } catch {
        // Keep the dialog open so the user can retry without losing input.
        // The global mutation handler shows the normalized failure.
      }
    },
    [onClose, onSubmit]
  );

  return (
    <SimpleDialog
      footer={
        <>
          <Button
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button disabled={submitDisabled} size="lg" type="submit">
            {!isSubmitting && (
              <span>{isEdit ? m.action_save() : m.action_create()}</span>
            )}
            {isSubmitting && (
              <span>
                <Spinner />
              </span>
            )}
          </Button>
        </>
      }
      onClose={onClose}
      onSubmit={formSubmit(handleSubmit)}
      open={open}
      title={isEdit ? m.action_edit() : m.schedule_new_event()}
    >
      <div className="flex flex-col gap-4">
        <Controller
          control={control}
          name="title"
          render={({ field, fieldState }) => (
            <label className="flex flex-col gap-1.5">
              <InputTitle required>{m.common_title()}</InputTitle>
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                autoFocus
                placeholder={m.schedule_event_title()}
              />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </label>
          )}
        />

        <Controller
          control={control}
          name="date"
          render={({ field, fieldState }) => (
            <label className="flex flex-col gap-1.5">
              <InputTitle required>{m.common_date()}</InputTitle>
              <Input {...field} aria-invalid={fieldState.invalid} type="date" />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </label>
          )}
        />

        <div className="flex gap-3">
          <Controller
            control={control}
            name="startTime"
            render={({ field, fieldState }) => (
              <label className="flex flex-1 flex-col gap-1.5">
                <InputTitle required>{m.common_start()}</InputTitle>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  type="time"
                />
                {fieldState.invalid && (
                  <InputError errors={[fieldState.error]} />
                )}
              </label>
            )}
          />
          <Controller
            control={control}
            name="endTime"
            render={({ field, fieldState }) => (
              <label className="flex flex-1 flex-col gap-1.5">
                <InputTitle required>{m.common_end()}</InputTitle>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  type="time"
                />
                {fieldState.invalid && (
                  <InputError errors={[fieldState.error]} />
                )}
              </label>
            )}
          />
        </div>

        <Controller
          control={control}
          name="location"
          render={({ field, fieldState }) => (
            <label className="flex flex-col gap-1.5">
              <InputTitle>{m.common_location()}</InputTitle>
              <Input
                {...field}
                aria-invalid={fieldState.invalid}
                placeholder={m.common_optional()}
              />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </label>
          )}
        />

        {labels.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <InputTitle>{m.common_labels()}</InputTitle>
            <div className="flex flex-wrap gap-1.5">
              {labels.map((l) => {
                const on = labelIds.includes(l.id);
                const p = userColorPair(l.color);
                return (
                  <button
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium text-sm transition-colors',
                      on
                        ? 'border-transparent'
                        : 'border-line text-fg-muted hover:text-fg'
                    )}
                    key={l.id}
                    onClick={() => toggleLabel(l.id)}
                    style={on ? { background: p.bg, color: p.fg } : undefined}
                    type="button"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: on ? p.fg : p.bg }}
                    />
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </SimpleDialog>
  );
}
