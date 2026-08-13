import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { UpdateTaskBody } from '@/api/gen/validators';
import type { Task, UpdateTaskReq } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';

type TaskFormValues = Pick<UpdateTaskReq, 'title' | 'meta'>;

export function TaskEditDialog({
  task,
  open,
  onClose,
  onSave,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
  onSave: (patch: TaskFormValues) => Promise<unknown> | unknown;
}) {
  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
  } = useForm<TaskFormValues>({
    defaultValues: { meta: task.meta ?? '', title: task.title },
    mode: 'onChange',
    resolver: zodResolver(UpdateTaskBody),
  });

  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const handleSubmit = useCallback(
    async (v: TaskFormValues) => {
      try {
        await onSave({
          meta: v.meta?.trim() ?? '',
          title: v.title?.trim(),
        });
        onClose();
      } catch {
        // Keep the dialog open so the user can retry without losing input.
        // The global mutation handler shows the normalized failure.
      }
    },
    [onClose, onSave]
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
            {!isSubmitting && <span>{m.action_save()}</span>}
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
      title={m.action_edit()}
    >
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
              value={field.value ?? ''}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
      <Controller
        control={control}
        name="meta"
        render={({ field, fieldState }) => (
          <label className="mt-3 flex flex-col gap-1.5">
            <InputTitle>{m.common_meta()}</InputTitle>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              value={field.value ?? ''}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
    </SimpleDialog>
  );
}
