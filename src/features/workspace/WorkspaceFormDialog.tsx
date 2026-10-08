import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  CreateWorkspaceBody,
  createWorkspaceBodyDescriptionMax,
  createWorkspaceBodyTagsMax,
  UpdateWorkspaceBody,
} from '@/api/gen/validators';
import type { CoverConfig, CreateWorkspaceReq, Workspace } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { DialogFooter, SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { flattenTagErrors } from '@/components/ui/flattenTagErrors';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { TagSelect } from '@/components/ui/TagSelect';
import { Textarea } from '@/components/ui/TextArea';
import { m } from '@/i18n';
import { iconStyles, iconUrl } from '@/lib/icon-catalog';
import { CoverField } from './CoverField';

const workspaceIcons = iconStyles.find(
  (style) => style.id === 'waves'
)!.avatars;

/** Editing adds the card cover; null is None. Creating has no cover. */
export type WorkspaceFormValues = CreateWorkspaceReq & {
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
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  workspace: CreateWorkspaceReq &
    Partial<
      Pick<Workspace, 'chapterCount' | 'cover' | 'fileCount' | 'id' | 'privacy'>
    >;
  onSubmit: (values: WorkspaceFormValues) => Promise<Workspace | void>;
  mode: 'create' | 'edit';
  embedded?: boolean;
}) {
  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit,
    control,
    reset,
    setFocus,
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
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset({
        ...workspace,
        cover: mode === 'edit' ? (workspace.cover ?? null) : undefined,
        iconId:
          workspace.iconId ??
          (mode === 'create'
            ? workspaceIcons[Math.floor(Math.random() * workspaceIcons.length)]
                .id
            : undefined),
      });
    }
    wasOpen.current = open;
  }, [mode, open, reset, workspace]);

  const submit = handleSubmit(async (values) => {
    try {
      await onSubmit(values);
      setOpen(false);
    } catch {
      // Preserve the draft; the global mutation handler reports the failure.
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
      {mode === 'edit' && workspace.id && (
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
                ownerId={workspace.id ?? ''}
                value={field.value ?? null}
              />
            </div>
          )}
        />
      )}
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
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
            {fieldState.invalid && <InputError errors={[fieldState.error]} />}
          </label>
        )}
      />
      <Controller
        control={control}
        name="description"
        render={({ field, fieldState }) => (
          <label className="flex flex-col gap-1.5">
            <InputTitle>{m.summary_description_label()}</InputTitle>
            <Textarea
              {...field}
              aria-invalid={fieldState.invalid}
              maxLength={createWorkspaceBodyDescriptionMax}
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
    </div>
  );
  const footer = (
    <>
      {!embedded && (
        <Button
          onClick={() => setOpen(false)}
          size="lg"
          type="button"
          variant="ghost-hover"
        >
          {m.action_cancel()}
        </Button>
      )}
      <Button
        disabled={!isDirty || !isValid || isSubmitting}
        size="lg"
        type="submit"
        variant="accent"
      >
        {isSubmitting ? (
          <Spinner />
        ) : mode === 'create' ? (
          m.action_create()
        ) : (
          m.action_save()
        )}
      </Button>
    </>
  );
  if (embedded) {
    return (
      <form
        className="workspace-form flex h-full flex-col gap-4"
        onSubmit={submit}
      >
        {fields}
        <DialogFooter className="mt-auto">{footer}</DialogFooter>
      </form>
    );
  }
  return (
    <SimpleDialog
      footer={footer}
      formClassName="workspace-form"
      onClose={() => setOpen(false)}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        setFocus('name');
      }}
      onSubmit={submit}
      open={open}
      title={
        mode === 'create'
          ? m.workspace_create_title()
          : m.workspace_edit_title()
      }
    >
      {fields}
    </SimpleDialog>
  );
}
