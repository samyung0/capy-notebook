import { useState } from 'react';
import {
  type SubmissionOf,
  useSourceUploadPolicy,
  useUploadSource,
} from '@/api/hooks';
import { userToast } from '@/components/ui/userToast';
import { getFileKind } from '@/features/workspace/sourceUpload';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';

/** Adds picked files to a paper or a hand-in, each through the normal upload
 * with the attempt or assignment named, as one quiet batch. */
export function useAddSubmissionFiles(of: SubmissionOf) {
  const { data: policy } = useSourceUploadPolicy(undefined, {
    errorBoundary: false,
  });
  const { mutateAsync: upload } = useUploadSource(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const add = async (list: FileList | null) => {
    if (!list?.length || !policy) return;
    const picked = [...list];
    const batchId = crypto.randomUUID();
    setUploading((prev) => [...prev, ...picked.map((f) => f.name)]);
    for (const file of picked) {
      try {
        await upload({
          ...of,
          batchId,
          batchTotal: picked.length,
          file,
          kind: getFileKind(file.name, policy),
        });
      } catch (error) {
        userToast({
          title: errorCopy(error, m.assignment_paper_upload_failed()),
          variant: 'error',
        });
      } finally {
        setUploading((prev) => prev.filter((name) => name !== file.name));
      }
    }
  };
  return { add, ready: !!policy, uploading };
}
