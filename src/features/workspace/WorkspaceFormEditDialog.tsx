import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, type FieldError, useForm } from 'react-hook-form';
import type { UpdateWorkspaceReq } from '@/api/gen/model';
import { UpdateWorkspaceBody } from '@/api/gen/validators';
import type { Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { TagSelect } from '@/components/ui/TagSelect';
import { UserColorChooser } from '@/components/ui/UserColorChooser';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

export function WorkspaceFormEditDialog({
  open,
  setOpen,
  workspace,
  onSubmit,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: UpdateWorkspaceReq;
  onSubmit: (v: UpdateWorkspaceReq) => Promise<Workspace | void>;
}) {
  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
  } = useForm<UpdateWorkspaceReq>({
    defaultValues: workspace,
    mode: 'onChange',
    resolver: zodResolver(UpdateWorkspaceBody),
  });

  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const handleSubmit = useCallback(
    async (v: UpdateWorkspaceReq) => {
      try {
        await onSubmit(v);
        setOpen(false);
      } catch (err) {
        // Keep the dialog open so the user can retry without losing input.
        userToast({
          description:
            err instanceof Error
              ? err.message
              : 'Something went wrong. Please try again.',
          title: 'Could not save workspace',
          variant: 'error',
        });
      }
    },
    [onSubmit, setOpen, workspace]
  );

  return (
    <Dialog
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
      }}
      open={open}
    >
      <DialogContent
        className="min-h-2/3"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={true}
      >
        {/* TODO: i18n */}
        <DialogTitle>{'Edit Workspace'}</DialogTitle>

        <form
          className="flex h-full flex-col"
          onSubmit={formSubmit(handleSubmit)}
        >
          <div className="flex flex-col gap-5">
            <Controller
              control={control}
              name={'name'}
              render={({ field, fieldState }) => (
                <>
                  <label className="flex flex-col gap-1.5">
                    <InputTitle required>Chapter</InputTitle>
                    <Input
                      {...field}
                      aria-invalid={fieldState.invalid}
                      autoComplete="off"
                      autoFocus
                      placeholder="Workspace name"
                      required
                    />
                    {fieldState.invalid && (
                      <InputError errors={[fieldState.error]} />
                    )}
                  </label>
                </>
              )}
            />
            <Controller
              control={control}
              name={'tags'}
              render={({ field, fieldState }) => {
                const uniqueErrors = new Set();
                let uniqueErrorsArray: FieldError[] = [];

                if (fieldState.error) {
                  uniqueErrorsArray = (
                    fieldState.error as any as {
                      value: FieldError;
                    }[]
                  )
                    .map((error) => error.value)
                    .filter((error) => {
                      if (uniqueErrors.has(error.message)) return false;
                      uniqueErrors.add(error.message);
                      return true;
                    });
                }
                return (
                  <div className="flex flex-col gap-1.5">
                    <InputTitle>Tags</InputTitle>
                    <TagSelect
                      invalid={fieldState.invalid}
                      kind="workspace"
                      onChange={field.onChange}
                      value={field.value ?? []}
                    />
                    {fieldState.invalid && (
                      <InputError errors={uniqueErrorsArray} />
                    )}
                  </div>
                );
              }}
            />
            <Controller
              control={control}
              name={'color'}
              render={({ field, fieldState }) => (
                <>
                  <div className="flex flex-col gap-1.5">
                    <InputTitle>Color</InputTitle>
                    <UserColorChooser
                      aria-invalid={fieldState.invalid}
                      onChange={field.onChange}
                      selected={field.value}
                    />
                    {fieldState.invalid && (
                      <InputError errors={[fieldState.error]} />
                    )}
                  </div>
                </>
              )}
            />
          </div>
          <DialogFooter className="mt-auto">
            <DialogClose asChild>
              <Button
                onClick={() => setOpen(false)}
                size="lg"
                variant="ghost-hover"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={submitDisabled} size="lg">
              {!isSubmitting && <span>{m.action_save()}</span>}
              {isSubmitting && (
                <span>
                  <Spinner />
                </span>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
