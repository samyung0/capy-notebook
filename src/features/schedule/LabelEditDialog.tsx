import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { UpdateLabelBody } from '@/api/gen/validators';
import type { Label, UpdateLabelReq, UserColor } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { UserColorChooser } from '@/components/ui/UserColorChooser';
import { m } from '@/i18n';

export interface LabelFormValues {
  color: UserColor;
  name: string;
}

export function LabelEditDialog({
  label,
  open,
  onClose,
  onSave,
}: {
  label: Label;
  open: boolean;
  onClose: () => void;
  onSave: (patch: LabelFormValues) => Promise<unknown> | unknown;
}) {
  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
  } = useForm<UpdateLabelReq>({
    defaultValues: { color: label.color, name: label.name },
    mode: 'onChange',
    resolver: zodResolver(UpdateLabelBody),
  });

  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const handleSubmit = useCallback(
    async (v: UpdateLabelReq) => {
      if (!v.name?.trim() || !v.color) return;
      try {
        await onSave({ color: v.color, name: v.name.trim() });
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
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={submitDisabled} type="submit">
            {!isSubmitting && <span>Save</span>}
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
      <div className="flex flex-col gap-4">
        <Controller
          control={control}
          name="name"
          render={({ field, fieldState }) => (
            <label className="flex flex-col gap-1.5">
              <InputTitle required>Name</InputTitle>
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
          name="color"
          render={({ field, fieldState }) => (
            <div className="flex flex-col gap-1.5">
              <InputTitle>Color</InputTitle>
              <UserColorChooser
                onChange={field.onChange}
                selected={field.value}
              />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </div>
          )}
        />
      </div>
    </SimpleDialog>
  );
}
