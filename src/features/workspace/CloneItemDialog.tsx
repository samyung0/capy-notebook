import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  isApiError,
  isMaterialContentUnreadable,
  isStorageQuotaError,
} from '@/api/client';
import {
  CloneFileBody,
  CloneMaterialBody,
  cloneFileBodyNameMax,
  cloneMaterialBodyTitleMax,
} from '@/api/gen/validators';
import {
  useChapters,
  useCloneFile,
  useCloneMaterial,
  useWorkspaces,
} from '@/api/hooks';
import type { Material } from '@/api/types';
import { SettingRow } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { trackQuotaBlocked } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';
import { textLength } from '@/lib/textLength';
import { ChapterSelect, chapterByName, NewChapterInput } from './ChapterSelect';

/** What a clone copies: a file (into a workspace only) or a material; an
 * empty workspaceId is a standalone material. */
export type CloneItem =
  | { type: 'file'; id: string; name: string; workspaceId: string }
  | {
      type: 'material';
      id: string;
      kind: string;
      name: string;
      workspaceId: string;
    };

const STANDALONE = '__standalone__';

/** "Name (copy)"; a file keeps its extension last: "lesson (copy).pdf". */
export function copyName(name: string, keepExtension = false) {
  const dot = keepExtension ? name.lastIndexOf('.') : -1;
  return dot > 0
    ? m.copy_name({ name: name.slice(0, dot) }) + name.slice(dot)
    : m.copy_name({ name });
}

/** A refused clone as its dialog shows it. */
export function cloneErrorMessage(error: unknown) {
  if (isStorageQuotaError(error)) {
    // The numbers come only for the account charged: without them the
    // destination's owner pays, and it is their storage that is full.
    if (!error.body?.ownerUserId) return m.clone_owner_quota_body();
    trackQuotaBlocked(error, 'clone');
    return m.clone_quota_body();
  }
  // Past the payer's per-file plan cap, as an upload is refused.
  if (
    isApiError(error) &&
    error.code === 'file_too_large' &&
    typeof error.body?.maxBytes === 'number'
  ) {
    return m.source_files_too_large({
      mb: Math.round(error.body.maxBytes / 1024 / 1024),
    });
  }
  // The source's stored content the current rules refuse: another name or
  // destination cannot help (Epo 2026-10-20).
  if (isMaterialContentUnreadable(error)) return m.clone_unreadable();
  return errorCopy(error, m.source_try_again());
}

function cloneTitle(item: CloneItem) {
  if (item.type === 'file') return m.action_clone_file();
  switch (item.kind) {
    case 'quiz':
      return m.action_clone_quiz();
    case 'flashcards':
      return m.action_clone_flashcards();
    case 'note':
      return m.action_clone_note();
    default:
      return m.action_clone();
  }
}

/**
 * Clone a file or material: a destination workspace the user edits (a
 * material may also go to No workspace), a chapter in it, and the copy's name,
 * `Name (copy)` while it sits next to its source. Clone spins and the dialog
 * stays open until the copy opens; a taken name shows under the field and any
 * other refusal under the form.
 */
export function CloneItemDialog({
  item,
  onClose,
  onCloned,
}: {
  item: CloneItem;
  onClose: () => void;
  /** Runs before the app opens the copy. */
  onCloned?: () => void;
}) {
  const navigate = useNavigate();
  const isFile = item.type === 'file';
  const { data: workspaces, isPending: workspacesPending } = useWorkspaces();
  const editable = (workspaces ?? []).filter((ws) => ws.capabilities.canEdit);
  // The source's workspace when the user edits it, else the first one they
  // edit; a standalone material stays standalone.
  const fallback = isFile || item.workspaceId ? editable[0]?.id : undefined;
  const [picked, setPicked] = useState('');
  const destination =
    picked ||
    (editable.some((ws) => ws.id === item.workspaceId)
      ? item.workspaceId
      : (fallback ?? (isFile ? '' : STANDALONE)));
  const workspaceId = destination === STANDALONE ? '' : destination;
  const { data: chapters } = useChapters(workspaceId);
  const [chapter, setChapter] = useState<{
    chapterId: string | null;
    chapterName: string | null;
  }>({ chapterId: null, chapterName: null });
  const [newChapter, setNewChapter] = useState<string | null>(null);
  const [nameEdited, setNameEdited] = useState(false);
  const [formError, setFormError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const { mutateAsync: cloneFile } = useCloneFile({ errorToast: false });
  const { mutateAsync: cloneMaterial } = useCloneMaterial({
    errorToast: false,
  });

  const nameMax = isFile ? cloneFileBodyNameMax : cloneMaterialBodyTitleMax;
  const {
    control,
    formState: { isSubmitting },
    handleSubmit,
    setError,
    setValue,
    trigger,
  } = useForm<{ name: string }>({
    defaultValues: { name: item.name },
    mode: 'onChange',
    resolver: zodResolver(
      z.object({
        name: isFile ? CloneFileBody.shape.name : CloneMaterialBody.shape.title,
      })
    ),
  });
  // Until the user types a name, it follows the destination: a copy next to
  // its source is told apart by its suffix. A suffix past the limit shows why
  // Clone is refused before the user types.
  useEffect(() => {
    if (nameEdited) return;
    const same = !!item.workspaceId && destination === item.workspaceId;
    setValue('name', same ? copyName(item.name, isFile) : item.name, {
      shouldValidate: true,
    });
  }, [destination, isFile, item.name, item.workspaceId, nameEdited, setValue]);

  const submit = handleSubmit(async ({ name }) => {
    setFormError(null);
    // A chapter name still being typed counts, so Clone never drops it.
    const typed = newChapter?.trim();
    const { chapterId, chapterName } = typed
      ? chapterByName(chapters, typed)
      : chapter;
    const where = {
      chapterId: chapterId ?? undefined,
      chapterName: chapterName ?? undefined,
      workspaceId,
    };
    try {
      if (isFile) {
        const file = await cloneFile({ body: { ...where, name }, id: item.id });
        onCloned?.();
        await navigate({
          params: { workspaceId: file.workspaceId },
          search: { file: file.id },
          to: '/workspaces/$workspaceId',
        });
      } else {
        const material = await cloneMaterial({
          body: workspaceId ? { ...where, title: name } : { title: name },
          id: item.id,
        });
        onCloned?.();
        await openMaterialCopy(material);
      }
      // A copy opened on the same path (the source's workspace) keeps the
      // dialog mounted.
      onClose();
    } catch (error) {
      if (isApiError(error) && error.code === 'title_taken') {
        setError('name', { message: m.error_title_taken_body() });
        return;
      }
      setFormError({
        errorId: unexpectedErrorId(error),
        message: cloneErrorMessage(error),
      });
    }
  });

  function openMaterialCopy(material: Material) {
    // A copy in a workspace opens there; only a standalone one has its own page.
    if (material.workspaceId) {
      return navigate({
        params: { workspaceId: material.workspaceId },
        search: { material: material.id },
        to: '/workspaces/$workspaceId',
      });
    }
    switch (material.kind) {
      case 'quiz':
        return navigate({
          params: { quizId: material.id },
          to: '/quizzes/$quizId/attempt',
        });
      case 'flashcards':
        return navigate({
          params: { flashcardSetId: material.id },
          to: '/flashcards/$flashcardSetId',
        });
      default:
        return navigate({
          params: { materialId: material.id },
          to: '/materials/$materialId',
        });
    }
  }

  const noDestination = !(workspacesPending || editable.length || !isFile);
  return (
    <SimpleDialog
      footer={
        <>
          <Button
            disabled={isSubmitting}
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            disabled={isSubmitting || !destination || workspacesPending}
            size="lg"
            type="submit"
            variant="accent"
          >
            {isSubmitting ? <Spinner /> : m.action_clone()}
          </Button>
        </>
      }
      // While pending the dialog stays: the request ends in the copy or in
      // its refusal shown here (the success path closes it itself).
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      onSubmit={submit}
      open
      showCloseButton={!isSubmitting}
      title={cloneTitle(item)}
      width={560}
    >
      {noDestination ? (
        <p className="text-fg-muted">
          {m.question_ui_no_editable_workspaces()}
        </p>
      ) : (
        // The form draws while workspaces load, so nothing shifts when they land.
        <div className="flex flex-col gap-4">
          <SettingRow title={m.question_ui_workspace()}>
            <Select
              onValueChange={(id) => {
                // The form's hidden native select reports '' while options load.
                if (!id) return;
                setPicked(id);
                // A refusal belonged to the old destination.
                setFormError(null);
                void trigger('name');
                // Chapters belong to the old workspace.
                setChapter({ chapterId: null, chapterName: null });
                setNewChapter(null);
              }}
              value={destination}
            >
              <SelectTrigger
                aria-label={m.question_ui_workspace()}
                disabled={workspacesPending || isSubmitting}
                layout="row"
                loading={workspacesPending}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent layout="row">
                {!isFile && (
                  <SelectItem value={STANDALONE}>
                    <span className="text-fg-muted">
                      {m.clone_no_workspace()}
                    </span>
                  </SelectItem>
                )}
                {editable.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>
                    <span className="flex min-w-0 items-center gap-2">
                      <img
                        alt=""
                        className="size-5 shrink-0 -translate-y-px rounded-md"
                        src={iconUrl(ws.iconId)}
                      />
                      <span className="truncate">{ws.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          {/* Hidden, not removed, without a workspace: no layout shift. */}
          <div
            aria-hidden={!workspaceId}
            className={cn(!workspaceId && 'invisible')}
          >
            <SettingRow title={m.question_ui_chapter()}>
              {newChapter === null ? (
                <ChapterSelect
                  chapterName={chapter.chapterName}
                  chapters={chapters ?? []}
                  disabled={!workspaceId || isSubmitting}
                  field
                  onChange={(chapterId) =>
                    setChapter({ chapterId, chapterName: null })
                  }
                  onCreateRequest={() => setNewChapter('')}
                  value={chapter.chapterId}
                />
              ) : (
                <NewChapterInput
                  field
                  onCancel={() => setNewChapter(null)}
                  onChange={setNewChapter}
                  onConfirm={() => {
                    const name = newChapter.trim();
                    if (!name) return;
                    setChapter(chapterByName(chapters, name));
                    setNewChapter(null);
                  }}
                  value={newChapter}
                />
              )}
            </SettingRow>
          </div>
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <label className="flex flex-col gap-1.5">
                <InputTitle
                  count={{ max: nameMax, value: textLength(field.value) }}
                  required
                >
                  {m.common_name()}
                </InputTitle>
                <Input
                  {...field}
                  aria-invalid={fieldState.invalid}
                  autoComplete="off"
                  onChange={(event) => {
                    setNameEdited(true);
                    field.onChange(event);
                  }}
                  required
                />
                {fieldState.invalid && (
                  <InputError errors={[fieldState.error]} />
                )}
              </label>
            )}
          />
          <FormAlert
            errorId={formError?.errorId}
            message={formError?.message ?? null}
          />
        </div>
      )}
    </SimpleDialog>
  );
}
