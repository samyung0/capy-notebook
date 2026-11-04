import { type FormEvent, useState } from 'react';
import { isApiError } from '@/api/client';
import { useAddTopic, useMoveFile, useMoveFiles } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { DestinationFields, useItemDestination } from './ItemDestination';

/** A file Move to… acts on; an empty workspaceId is a standalone file. */
export interface MoveFileItem {
  id: string;
  name: string;
  topicId: string | null;
  workspaceId: string;
}

/** A refused move as its dialog shows it. */
export function moveErrorMessage(error: unknown) {
  if (isApiError(error) && error.code === 'file_processing')
    return m.move_file_processing();
  return errorCopy(error, m.source_try_again());
}

/**
 * Move to…: the clone dialog's workspace and topic dropdowns, with the
 * file's own workspace and topic preselected and tagged Current, and no No
 * workspace (a move never takes a file out of one). Another topic of the
 * same workspace is a topic move (PATCH); another workspace goes through
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
  const { mutateAsync: moveFiles } = useMoveFiles({ errorToast: false });
  const dest = useItemDestination({
    standalone: false,
    topicId: file.topicId,
    workspaceId: file.workspaceId,
  });
  const { workspaceId } = dest;
  const { mutateAsync: moveToTopic } = useMoveFile(file.workspaceId);
  const { mutateAsync: addTopic } = useAddTopic(file.workspaceId);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const same = workspaceId === file.workspaceId;
  const unchanged =
    same &&
    dest.newTopic === null &&
    dest.topic.topicName === null &&
    dest.topic.topicId === file.topicId;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !workspaceId || unchanged) return;
    setFormError(null);
    setSubmitting(true);
    // A topic name still being typed counts, so Move never drops it.
    const { topicId, topicName } = dest.resolve();
    try {
      if (same) {
        const id = topicName ? (await addTopic(topicName)).id : topicId;
        await moveToTopic({ id: file.id, topicId: id });
        onClose();
        return;
      }
      const moved = await moveFiles({
        body: {
          fileIds: [file.id],
          topicId: topicId ?? undefined,
          topicName: topicName ?? undefined,
          workspaceId,
        },
        from: [file.workspaceId],
      });
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
  );
}
