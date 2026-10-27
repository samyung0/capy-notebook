import { type FormEvent, type ReactNode, useState } from 'react';
import { isApiError } from '@/api/client';
import { useAddChapter, useMoveFile, useMoveFiles } from '@/api/hooks';
import type { MoveFilesReq, SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { DestinationFields, useItemDestination } from './ItemDestination';

/** A file Move to… acts on; an empty workspaceId is a standalone file. */
export interface MoveFileItem {
  chapterId: string | null;
  id: string;
  name: string;
  workspaceId: string;
  /** Names the left workspace in the progress confirmation. */
  workspaceName?: string;
}

/** What the progress confirmation names: one file and its workspace, or a
 * count. */
export type MoveSubject =
  | { name: string; workspaceName: string }
  | { count: number };

/** A refused move as its dialog shows it. */
export function moveErrorMessage(error: unknown) {
  if (isApiError(error) && error.code === 'file_processing')
    return m.move_file_processing();
  return errorCopy(error, m.source_try_again());
}

function progressLoss(error: unknown) {
  if (!isApiError(error) || error.code !== 'progress_loss') return null;
  const { people, planSteps } = error.body ?? {};
  return {
    people: typeof people === 'number' ? people : 0,
    planSteps: typeof planSteps === 'number' ? planSteps : 0,
  };
}

/**
 * POST /files/move that asks first when the left workspaces would lose study
 * progress or plan steps (a 409 `progress_loss`), then resends with
 * `confirmProgressLoss`. `move` resolves to the moved files, or null when the
 * user kept them; any other refusal throws. Render `confirm`.
 */
export function useMoveFilesFlow(targetName: string) {
  const { mutateAsync } = useMoveFiles({ errorToast: false });
  const [asking, setAsking] = useState<{
    loss: { people: number; planSteps: number };
    resolve: (ok: boolean) => void;
    subject: MoveSubject;
  } | null>(null);

  async function move(
    body: MoveFilesReq,
    from: string[],
    subject: MoveSubject
  ): Promise<SourceFile[] | null> {
    try {
      return await mutateAsync({ body, from });
    } catch (error) {
      const loss = progressLoss(error);
      if (!loss) throw error;
      const ok = await new Promise<boolean>((resolve) =>
        setAsking({ loss, resolve, subject })
      );
      setAsking(null);
      if (!ok) return null;
      return mutateAsync({
        body: { ...body, confirmProgressLoss: true },
        from,
      });
    }
  }

  const confirm: ReactNode = asking && (
    <ConfirmDialog
      confirmLabel={m.action_move()}
      onClose={() => asking.resolve(false)}
      onConfirm={() => asking.resolve(true)}
      open
      title={m.move_progress_title({ workspace: targetName })}
    >
      <ProgressLossBody loss={asking.loss} subject={asking.subject} />
    </ConfirmDialog>
  );
  return { confirm, move };
}

function ProgressLossBody({
  loss,
  subject,
}: {
  loss: { people: number; planSteps: number };
  subject: MoveSubject;
}) {
  const lines = [
    loss.people > 0 &&
      (loss.people === 1
        ? m.move_progress_people_one()
        : m.move_progress_people({ count: loss.people })),
    loss.planSteps > 0 &&
      (loss.planSteps === 1
        ? m.move_progress_steps_one()
        : m.move_progress_steps({ count: loss.planSteps })),
  ].filter((line) => line !== false);
  return (
    <div className="flex flex-col gap-2 text-[0.9375rem] sm:text-base">
      <p>
        {'count' in subject
          ? m.move_progress_lead_files({ count: subject.count })
          : m.move_progress_lead({
              file: subject.name,
              workspace: subject.workspaceName,
            })}
      </p>
      <ul className="list-disc pl-5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Move to…: the clone dialog's workspace and chapter dropdowns, with the
 * file's own workspace and chapter preselected and tagged Current, and no No
 * workspace (a move never takes a file out of one). Another chapter of the
 * same workspace is a chapter move (PATCH); another workspace goes through
 * POST /files/move.
 */
export function MoveFileDialog({
  file,
  onClose,
  onMoved,
}: {
  file: MoveFileItem;
  onClose: () => void;
  /** After a move into another workspace. */
  onMoved?: (file: SourceFile) => void;
}) {
  const dest = useItemDestination({
    chapterId: file.chapterId,
    standalone: false,
    workspaceId: file.workspaceId,
  });
  const { workspaceId } = dest;
  const target = dest.editable.find((ws) => ws.id === workspaceId);
  const { confirm, move } = useMoveFilesFlow(target?.name ?? '');
  const { mutateAsync: moveToChapter } = useMoveFile(file.workspaceId);
  const { mutateAsync: addChapter } = useAddChapter(file.workspaceId);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const same = workspaceId === file.workspaceId;
  const unchanged =
    same &&
    dest.newChapter === null &&
    dest.chapter.chapterName === null &&
    dest.chapter.chapterId === file.chapterId;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !workspaceId || unchanged) return;
    setFormError(null);
    setSubmitting(true);
    // A chapter name still being typed counts, so Move never drops it.
    const { chapterId, chapterName } = dest.resolve();
    try {
      if (same) {
        const id = chapterName ? (await addChapter(chapterName)).id : chapterId;
        await moveToChapter({ chapterId: id, id: file.id });
        onClose();
        return;
      }
      const moved = await move(
        {
          chapterId: chapterId ?? undefined,
          chapterName: chapterName ?? undefined,
          fileIds: [file.id],
          workspaceId,
        },
        [file.workspaceId],
        {
          name: file.name,
          workspaceName:
            dest.editable.find((ws) => ws.id === file.workspaceId)?.name ??
            file.workspaceName ??
            '',
        }
      );
      if (!moved) return;
      if (moved[0]) onMoved?.(moved[0]);
      onClose();
    } catch (error) {
      setFormError({
        errorId: unexpectedErrorId(error),
        message: moveErrorMessage(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <SimpleDialog
        action={
          <Button
            disabled={submitting || !workspaceId || unchanged || dest.pending}
            size="lg"
            type="submit"
            variant="accent"
          >
            {submitting ? <Spinner /> : m.action_move()}
          </Button>
        }
        onClose={() => {
          if (!submitting) onClose();
        }}
        onSubmit={submit}
        open
        pending={submitting}
        title={m.content_move_file()}
        width={560}
      >
        <div className="flex flex-col gap-4">
          <DestinationFields
            dest={dest}
            disabled={submitting}
            markCurrent
            onPick={() => setFormError(null)}
          />
          <FormAlert
            errorId={formError?.errorId}
            message={formError?.message ?? null}
          />
        </div>
      </SimpleDialog>
      {confirm}
    </>
  );
}
