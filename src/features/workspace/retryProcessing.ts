import type { useRetryFileProcessing } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The toast once Retry processing is queued. */
export function retryStartedToast() {
  userToast({
    description: m.files_retry_started_body(),
    title: m.files_process_started_title(),
    variant: 'success',
  });
}

/** Retry processing of a failed file. One that is still indexed (a part
 * missing) runs in one click with no upload dialog (parts design Q8): the
 * server re-runs only its missing parts in the file's own parse mode. An
 * indexed file was processed on the fast route or a direct route, which
 * ignores the mode, so 'fast' names its route. Any other failed file opens
 * the dialog to pick a parse mode. */
export function retryFailedFile(
  file: Pick<SourceFile, 'id' | 'indexed'>,
  retryProcessing: ReturnType<typeof useRetryFileProcessing>['mutateAsync'],
  openDialog: () => void
) {
  if (!file.indexed) {
    openDialog();
    return;
  }
  void retryProcessing({ id: file.id, parseMode: 'fast' }).then(
    retryStartedToast,
    () => {}
  );
}
