import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  CreateWorkspaceBody,
  createWorkspaceBodyTagsMax,
} from '@/api/gen/validators';
import type { CreateWorkspaceReq, Workspace } from '@/api/types';
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
import { flattenTagErrors, TagSelect } from '@/components/ui/TagSelect';
import { UserColorChooser } from '@/components/ui/UserColorChooser';
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
  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
  } = useForm<CreateWorkspaceReq>({
    defaultValues: workspace,
    mode: 'onChange',
    resolver: zodResolver(CreateWorkspaceBody),
  });

  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const handleSubmit = useCallback(
    async (v: CreateWorkspaceReq) => {
      if (!v) return;
      try {
        await onSubmit(v);
        setOpen(false);
      } catch {
        // Keep the dialog open so the user can retry without losing input.
        // The global mutation handler shows the normalized failure.
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
        className="min-h-2/3"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={true}
      >
        <DialogTitle>{m.workspace_create_title()}</DialogTitle>

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
                    <InputTitle required>{m.common_name()}</InputTitle>
                    <Input
                      {...field}
                      aria-invalid={fieldState.invalid}
                      autoComplete="off"
                      autoFocus
                      placeholder={m.workspace_name_placeholder()}
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
              render={({ field, fieldState }) => (
                <div className="flex flex-col gap-1.5">
                  <InputTitle>{m.common_tags()}</InputTitle>
                  <TagSelect
                    invalid={fieldState.invalid}
                    kind="workspace"
                    max={createWorkspaceBodyTagsMax}
                    onChange={field.onChange}
                    value={field.value ?? []}
                  />
                  {fieldState.invalid && (
                    <InputError errors={flattenTagErrors(fieldState.error)} />
                  )}
                </div>
              )}
            />
            <Controller
              control={control}
              name={'color'}
              render={({ field, fieldState }) => (
                <>
                  <div className="flex flex-col gap-1.5">
                    <InputTitle>{m.common_color()}</InputTitle>
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
                {m.action_cancel()}
              </Button>
            </DialogClose>
            <Button disabled={submitDisabled} size="lg">
              {!isSubmitting && <span>{m.action_create()}</span>}
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
