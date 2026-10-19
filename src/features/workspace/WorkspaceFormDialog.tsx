import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  CreateWorkspaceBody,
  createWorkspaceBodyDescriptionMax,
  createWorkspaceBodyNameMax,
  createWorkspaceBodyTagsItemValueMax,
  createWorkspaceBodyTagsMax,
  UpdateWorkspaceBody,
} from '@/api/gen/validators';
import type { CoverConfig, CreateWorkspaceReq, Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  DialogFooter,
  DialogHeaderAction,
  SimpleDialog,
  useIsPhone,
} from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { flattenTagErrors } from '@/components/ui/flattenTagErrors';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { TagSelect } from '@/components/ui/TagSelect';
import { Textarea } from '@/components/ui/TextArea';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { iconStyles, iconUrl } from '@/lib/icon-catalog';
import { textLength } from '@/lib/textLength';
import { CoverField } from './CoverField';
import { randomSeed } from './CoverPicker';

const workspaceIcons = iconStyles.find(
  (style) => style.id === 'waves'
)!.avatars;

/** The card cover; null is None. */
export type WorkspaceFormValues = Omit<CreateWorkspaceReq, 'cover'> & {
  cover?: CoverConfig | null;
};
const WorkspaceFormBody = CreateWorkspaceBody.extend({
  cover: UpdateWorkspaceBody.shape.cover.nullable(),
});

export function WorkspaceFormDialog({
  open,
  setOpen,
  workspace,
  onSubmit,
  mode,
  embedded = false,
  errorMessage,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: CreateWorkspaceReq &
    Partial<
      Pick<Workspace, 'chapterCount' | 'cover' | 'fileCount' | 'id' | 'privacy'>
    >;
  onSubmit: (values: WorkspaceFormValues) => Promise<Workspace | void>;
  /** clone creates like create, from a form prefilled with the source. */
  mode: 'create' | 'clone' | 'edit';
  embedded?: boolean;
  /** Shows a failed submit under the form; without it the mutation's own
   * toast reports it. */
  errorMessage?: (error: unknown) => string;
}) {
  const formId = useId();
  const phone = useIsPhone();
  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit,
    control,
    reset,
    setFocus,
    trigger,
  } = useForm<WorkspaceFormValues>({
    defaultValues: workspace,
    mode: 'onChange',
    resolver: zodResolver(WorkspaceFormBody),
  });
  // The cover picker previews the card with the unsaved name, icon and tags.
  const [name, iconId, tags] = useWatch({
    control,
    name: ['name', 'iconId', 'tags'],
  });
  // A new workspace has no id to seed its cover art yet, so the preview uses a
  // random seed that the created cover keeps.
  const [draftSeed] = useState(randomSeed);
  const ownerId = workspace.id ?? draftSeed;
  const [formError, setFormError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setFormError(null);
      reset({
        ...workspace,
        cover: workspace.cover ?? null,
        iconId:
          workspace.iconId ??
          (mode === 'create'
            ? workspaceIcons[Math.floor(Math.random() * workspaceIcons.length)]
                .id
            : undefined),
      });
      // A prefilled copy can start over a limit (a name with its suffix):
      // show why Clone is off before the user types.
      if (mode === 'clone') void trigger();
    }
    wasOpen.current = open;
  }, [mode, open, reset, trigger, workspace]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const { cover } = values;
      await onSubmit(
        mode !== 'edit' && cover && !cover.seed
          ? { ...values, cover: { ...cover, seed: draftSeed } }
          : values
      );
      setOpen(false);
    } catch (error) {
      // Preserve the draft; the form or the mutation's toast reports it.
      if (errorMessage)
        setFormError({
          errorId: unexpectedErrorId(error),
          message: errorMessage(error),
        });
    }
  });
  const fields = (
    <div className="flex flex-col gap-5">
      <Controller
        control={control}
        name="iconId"
        render={({ field, fieldState }) => (
          <div className="flex flex-col gap-1.5">
            <InputTitle>{m.icon_label()}</InputTitle>
            <div className="flex items-center gap-5">
              {field.value && (
                <img
                  alt=""
                  className="size-14 rounded-card"
                  height={56}
                  src={iconUrl(field.value)}
                  width={56}
                />
              )}
              <IconPicker
                disabled={isSubmitting}
                onChange={field.onChange}
                value={field.value}
              />
            </div>
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </div>
        )}
      />
      <Controller
        control={control}
        name="cover"
        render={({ field }) => (
          <div className="flex flex-col gap-1.5">
            <InputTitle>{m.cover_label()}</InputTitle>
            <CoverField
              card={{
                chapterCount: workspace.chapterCount ?? 0,
                fileCount: workspace.fileCount ?? 0,
                iconId: iconId ?? workspace.iconId ?? '',
                name: name || workspace.name,
                privacy: workspace.privacy ?? 'private',
                tags: tags ?? [],
              }}
              disabled={isSubmitting}
              onChange={field.onChange}
              ownerId={ownerId}
              value={field.value ?? null}
            />
          </div>
        )}
      />
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <InputTitle
              count={{
                max: createWorkspaceBodyNameMax,
                value: textLength(field.value),
              }}
              required
            >
              {m.common_name()}
            </InputTitle>
            <Input
              {...field}
              aria-invalid={fieldState.invalid}
              autoComplete="off"
              autoFocus
              placeholder={m.workspace_name_placeholder()}
              required
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
      <Controller
        control={control}
        name="description"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <InputTitle
              count={{
                max: createWorkspaceBodyDescriptionMax,
                value: textLength(field.value),
              }}
            >
              {m.summary_description_label()}
            </InputTitle>
            <Textarea
              {...field}
              aria-invalid={fieldState.invalid}
              placeholder={m.summary_description_placeholder()}
              value={field.value ?? ''}
            />
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
      <Controller
        control={control}
        name="tags"
        render={({ field, fieldState }) => (
          <div className="flex flex-col gap-1.5">
            <InputTitle
              count={{
                from: createWorkspaceBodyTagsMax - 1,
                max: createWorkspaceBodyTagsMax,
                value: field.value?.length ?? 0,
              }}
            >
              {m.common_tags()}
            </InputTitle>
            <TagSelect
              invalid={fieldState.invalid}
              kind="workspace"
              max={createWorkspaceBodyTagsMax}
              maxLength={createWorkspaceBodyTagsItemValueMax}
              onChange={field.onChange}
              value={field.value ?? []}
            />
            {fieldState.invalid && (
              <InputError errors={flattenTagErrors(fieldState.error)} />
            )}
          </div>
        )}
      />
      <FormAlert
        errorId={formError?.errorId}
        message={formError?.message ?? null}
      />
    </div>
  );
  const submitButton = (
    <Button
      disabled={(mode === 'edit' && !isDirty) || !isValid || isSubmitting}
      // The phone header holds it outside the form's DOM.
      form={formId}
      size="lg"
      type="submit"
      variant="accent"
    >
      {isSubmitting ? (
        <Spinner />
      ) : (
        {
          clone: m.action_clone(),
          create: m.action_create(),
          edit: m.action_save(),
        }[mode]
      )}
    </Button>
  );
  if (embedded) {
    return (
      <form
        className="workspace-form flex h-full flex-col gap-4"
        id={formId}
        onSubmit={submit}
      >
        {fields}
        {phone ? (
          <DialogHeaderAction>{submitButton}</DialogHeaderAction>
        ) : (
          <DialogFooter className="mt-auto">{submitButton}</DialogFooter>
        )}
      </form>
    );
  }
  return (
    <SimpleDialog
      action={submitButton}
      formClassName="workspace-form"
      formId={formId}
      // While pending the dialog stays, so a refusal still shows in its form.
      onClose={() => {
        if (!isSubmitting) setOpen(false);
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        setFocus('name');
      }}
      onSubmit={submit}
      open={open}
      pending={isSubmitting}
      title={
        {
          clone: m.action_clone_workspace(),
          create: m.workspace_create_title(),
          edit: m.workspace_edit_title(),
        }[mode]
      }
    >
      {fields}
    </SimpleDialog>
  );
}
