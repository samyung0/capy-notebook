import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { describeError, isStorageRefusal } from '@/lib/errors';

/** Process file changes, from the chat's pending-source notice, Generate's
 * too-large notice and the Indexing tab: a toast says it started, or why it
 * did not. Only the Indexing tab shows its progress. */
export function useProcessFileChanges(workspaceId: string) {
  const qc = useQueryClient();
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
    onSettled: () =>
      qc.invalidateQueries({ queryKey: qk.workspaceStats(workspaceId) }),
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

/** Takes a queued file back out of the queue; its edits stay. A file whose
 * processing started refuses with `processing_started`. */
export function useCancelFileChanges(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.del(`/files/${fileId}/process-changes`),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: qk.workspaceStats(workspaceId) }),
  });
}
