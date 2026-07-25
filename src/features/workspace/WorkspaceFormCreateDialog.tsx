import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { CreateWorkspaceReq } from '@/api/gen/model';
import { CreateWorkspaceBody } from '@/api/gen/validators';
import type { Workspace } from '@/api/types';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Input,
  InputError,
  Spinner,
  TagSelect,
  UserColorChooser,
} from '@/components/ui';
import { InputTitle } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

export function WorkspaceFormCreateDialog({
  open,
  setOpen,
  workspace,
  onSubmit,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: CreateWorkspaceReq;
  onSubmit: (v: CreateWorkspaceReq) => Promise<Workspace | void>;
}) {
  const form = useForm<CreateWorkspaceReq>({
    defaultValues: workspace,
    resolver: zodResolver(CreateWorkspaceBody),
  });

  const submitDisabled =
    !form.formState.isDirty ||
    !form.formState.isValid ||
    form.formState.isSubmitting;

  const handleSubmit = useCallback(
    async (v: CreateWorkspaceReq) => {
      if (!v) return;
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
          title: 'Damn what happened',
          variant: 'error',
        });
      }
    },
    [onSubmit, setOpen]
  );

  return (
    <Dialog
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
      }}
      open={open}
    >
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={true}
      >
        {/* TODO: i18n */}
        <DialogTitle>{'Create Workspace'}</DialogTitle>

        <form
          className="flex flex-col gap-5"
          onSubmit={form.handleSubmit(handleSubmit)}
        >
          <Controller
            control={form.control}
            name={'name'}
            render={({ field, fieldState }) => (
              <>
                <label className="flex flex-col gap-1.5">
                  <InputTitle required>Name</InputTitle>
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
            control={form.control}
            name={'tags'}
            render={({ field, fieldState }) => (
              <div className="flex flex-col gap-1.5">
                <InputTitle>Tags</InputTitle>
                <TagSelect
                  invalid={fieldState.invalid}
                  kind="workspace"
                  onChange={field.onChange}
                  value={field.value ?? []}
                />
                {fieldState.invalid && (
                  <InputError errors={[fieldState.error]} />
                )}
              </div>
            )}
          />
          <Controller
            control={form.control}
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
          <DialogFooter className="pt-12">
            <DialogClose asChild>
              <Button onClick={() => setOpen(false)} variant="ghost-hover">
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={submitDisabled}>
              {!form.formState.isSubmitting && <span>{m.action_create()}</span>}
              {form.formState.isSubmitting && (
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
