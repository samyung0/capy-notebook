import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';

type NameFields = { name: string };

export function NameFormDialog({
  open,
  onClose,
  title,
  fieldLabel,
  defaultName = '',
  maxLength,
  minLength = 1,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fieldLabel?: string;
  defaultName?: string;
  maxLength: number;
  minLength?: number;
  onSubmit: (name: string) => Promise<unknown> | unknown;
  submitLabel?: string;
}) {
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().min(minLength).max(maxLength),
      }),
    [maxLength, minLength]
  );

  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
  } = useForm<NameFields>({
    defaultValues: { name: defaultName },
    mode: 'onChange',
    resolver: zodResolver(schema),
  });

  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const handleSubmit = useCallback(
    async (v: NameFields) => {
      try {
        await onSubmit(v.name.trim());
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
            {!isSubmitting && <span>{submitLabel ?? m.action_save()}</span>}
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
      title={title}
    >
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <InputTitle required>{fieldLabel ?? m.common_name()}</InputTitle>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="off"
              autoFocus
              maxLength={maxLength}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
    </SimpleDialog>
  );
}
