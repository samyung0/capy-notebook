import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { describeError, isStorageRefusal } from '@/lib/errors';

/** Process file changes, from the chat's pending-source notice and Generate's
 * too-large notice: a toast says it started, or why it did not. Progress
 * itself stays invisible, like every reprocess. */
export function useProcessFileChanges() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: async (fileIds: string[]) => {
      const results = await Promise.allSettled(
        fileIds.map((id) => api.post(`/files/${id}/process-changes`, {}))
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    onError: (error) => {
      // A storage or frozen refusal already shows as the workspace status.
      if (isStorageRefusal(error)) return;
      userToast({
        description: describeError(error).description,
        id: 'process-file-changes',
        title: m.files_process_failed_title(),
        variant: 'error',
      });
    },
    onSuccess: () => {
      userToast({
        description: m.files_process_started_body(),
        id: 'process-file-changes',
        title: m.files_process_started_title(),
        variant: 'success',
      });
    },
  });
}
